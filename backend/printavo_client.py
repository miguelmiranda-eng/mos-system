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


async def fetch_recent_invoices(first: int = 25) -> list:
    """Return up to `first` most-recently-created invoices (raw GraphQL nodes).

    `first` is clamped to 30: Printavo enforces a per-query complexity limit
    (25000) and the nested line-item selections consume most of the budget.
    """
    data = await _graphql(INVOICES_QUERY, {"first": max(1, min(first, 30))})
    nodes = ((data.get("invoices") or {}).get("nodes")) or []
    logger.info(f"[printavo] fetched {len(nodes)} invoice(s) from API")
    return nodes
