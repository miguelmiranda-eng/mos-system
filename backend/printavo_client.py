"""Printavo GraphQL API v2 client.

Thin async wrapper over Printavo's GraphQL endpoint. Auth is via the
`email` + `token` headers generated in Printavo -> My Account -> API.

Used by the invoice auto-sync (printavo_sync.py) to pull the most recent
invoices and turn them into MOS orders. Printavo has no native webhooks and
no created-at sort field, so we sort by VISUAL_ID descending (the invoice
number is sequential, so highest = newest) and keep a high-water mark.
"""
import os
import httpx
from deps import logger

PRINTAVO_ENDPOINT = os.environ.get("PRINTAVO_API_URL", "https://www.printavo.com/api/v2")
PRINTAVO_EMAIL = os.environ.get("PRINTAVO_API_EMAIL", "")
PRINTAVO_TOKEN = os.environ.get("PRINTAVO_API_TOKEN", "")

# Newest invoices first (VISUAL_ID is a sequential invoice number), with each
# line item's size/quantity breakdown so we can rebuild the MOS sizes map.
INVOICES_QUERY = """
query RecentInvoices($first: Int!) {
  invoices(first: $first, sortOn: VISUAL_ID, sortDescending: true) {
    nodes {
      id
      visualId
      nickname
      createdAt
      customerDueAt
      dueAt
      total
      tags
      url
      workorderUrl
      customerNote
      status { name }
      contact {
        fullName
        customer { companyName }
      }
      lineItemGroups(first: 5) {
        nodes {
          lineItems(first: 20) {
            nodes {
              description
              color
              itemNumber
              items
              sizes { count size }
            }
          }
        }
      }
    }
  }
}
"""


def is_configured() -> bool:
    return bool(PRINTAVO_EMAIL and PRINTAVO_TOKEN)


async def _graphql(query: str, variables: dict) -> dict:
    if not is_configured():
        raise RuntimeError(
            "Printavo API credentials not configured "
            "(set PRINTAVO_API_EMAIL / PRINTAVO_API_TOKEN in .env)"
        )
    headers = {
        "email": PRINTAVO_EMAIL,
        "token": PRINTAVO_TOKEN,
        "Content-Type": "application/json",
    }
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(
            PRINTAVO_ENDPOINT,
            json={"query": query, "variables": variables},
            headers=headers,
        )
        resp.raise_for_status()
        data = resp.json()
        if data.get("errors"):
            raise RuntimeError(f"Printavo GraphQL errors: {data['errors']}")
        return data.get("data") or {}


CONTACTS_QUERY = """
query SearchContacts($q: String!) {
  contacts(first: 15, query: $q) {
    nodes { id fullName email customer { id companyName } }
  }
}
"""

QUOTE_CREATE = """
mutation CreateQuote($input: QuoteCreateInput!) {
  quoteCreate(input: $input) { id visualId }
}
"""


CONTACT_QUERY = """
query GetContact($id: ID!) {
  contact(id: $id) {
    id fullName
    customer {
      companyName
      billingAddress { address1 address2 city stateIso zipCode countryIso }
      shippingAddress { address1 address2 city stateIso zipCode countryIso }
    }
  }
}
"""


USERS_QUERY = """
query { account { users(first: 200) { nodes { id name email } } } }
"""


async def find_user_id_by_email(email: str):
    """Return the Printavo user id whose email matches (case-insensitive), else None.
    Used to set a quote's `owner` so it shows under the MOS user who created it,
    not under the shared API token's account."""
    if not email:
        return None
    data = await _graphql(USERS_QUERY, {})
    users = (((data.get("account") or {}).get("users") or {}).get("nodes")) or []
    e = email.strip().lower()
    for u in users:
        if (u.get("email") or "").strip().lower() == e:
            return u.get("id")
    return None


async def get_contact(contact_id: str) -> dict:
    """Fetch a contact's name + its customer's billing/shipping addresses (used to
    populate the quote's Customer Billing / Shipping, which Printavo does not copy
    automatically from the contact)."""
    data = await _graphql(CONTACT_QUERY, {"id": contact_id})
    return data.get("contact") or {}


async def search_contacts(q: str) -> list:
    """Search Printavo contacts by name/company for the review UI's customer picker."""
    data = await _graphql(CONTACTS_QUERY, {"q": q})
    nodes = ((data.get("contacts") or {}).get("nodes")) or []
    return [{
        "id": n.get("id"),
        "name": n.get("fullName"),
        "email": n.get("email"),
        "company": (n.get("customer") or {}).get("companyName"),
    } for n in nodes]


async def create_quote(quote_input: dict) -> dict:
    """Run the quoteCreate mutation. Returns {id, visualId}."""
    data = await _graphql(QUOTE_CREATE, {"input": quote_input})
    return (data.get("quoteCreate")) or {}


async def fetch_recent_invoices(first: int = 25) -> list:
    """Return up to `first` most-recently-created invoices (raw GraphQL nodes).

    `first` is clamped to 30: Printavo enforces a per-query complexity limit
    (25000) and the nested line-item selections consume most of the budget.
    """
    data = await _graphql(INVOICES_QUERY, {"first": max(1, min(first, 30))})
    nodes = ((data.get("invoices") or {}).get("nodes")) or []
    logger.info(f"[printavo] fetched {len(nodes)} invoice(s) from API")
    return nodes


# ── Final Bill sync ──────────────────────────────────────────────────────────
# When an invoice reaches the "Final Bill" status, MOS copies the invoice's
# Amount Outstanding and total item count onto the matching order (see
# printavo_sync.finalize_once). "Final Bill" is a late-lifecycle status, so the
# invoice is usually far outside the recent-VISUAL_ID window the create-sync
# polls — we therefore query Printavo directly by statusIds instead of scanning
# the newest invoices.

STATUSES_QUERY = """
query AllStatuses { statuses(first: 200) { nodes { id name } } }
"""

# Same line-item selection as INVOICES_QUERY (needed to recompute the total
# quantity) plus amountOutstanding and a status-id filter + cursor pagination.
FINAL_BILL_INVOICES_QUERY = """
query FinalBillInvoices($first: Int!, $after: String, $statusIds: [ID!]) {
  invoices(first: $first, after: $after, statusIds: $statusIds,
           sortOn: VISUAL_ID, sortDescending: true) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id
      visualId
      total
      amountOutstanding
      amountPaid
      status { id name }
      lineItemGroups(first: 5) {
        nodes {
          lineItems(first: 20) {
            nodes {
              description
              color
              itemNumber
              items
              sizes { count size }
            }
          }
        }
      }
    }
  }
}
"""


async def resolve_status_ids(names) -> list:
    """Resolve Printavo status NAMES (e.g. ["Final Bill"]) to their status IDs,
    matched case-insensitively. Returns [] if none match (caller no-ops)."""
    wanted = {str(n).strip().lower() for n in (names or []) if str(n).strip()}
    if not wanted:
        return []
    data = await _graphql(STATUSES_QUERY, {})
    nodes = ((data.get("statuses") or {}).get("nodes")) or []
    return [n["id"] for n in nodes
            if n.get("id") and (n.get("name") or "").strip().lower() in wanted]


async def fetch_invoices_by_status(status_ids: list, first: int = 30, after: str = None) -> dict:
    """Return one page of invoices currently in any of `status_ids`.

    Returns {"nodes": [...], "pageInfo": {"hasNextPage", "endCursor"}}. `first`
    is clamped to 30 for the same complexity-budget reason as fetch_recent_invoices.
    """
    variables = {"first": max(1, min(first, 30)), "after": after, "statusIds": status_ids}
    data = await _graphql(FINAL_BILL_INVOICES_QUERY, variables)
    conn = (data.get("invoices")) or {}
    nodes = conn.get("nodes") or []
    logger.info(f"[printavo] fetched {len(nodes)} final-bill invoice(s) from API")
    return {"nodes": nodes, "pageInfo": conn.get("pageInfo") or {}}
