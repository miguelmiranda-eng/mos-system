from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import RedirectResponse
from google_auth_oauthlib.flow import Flow
from googleapiclient.discovery import build
from google.oauth2.credentials import Credentials
from google.auth.transport.requests import Request as GoogleRequest
import os
import json
from datetime import datetime, timezone, timedelta

# Allow scope changes from Google (avoids the warning error you saw)
os.environ['OAUTHLIB_RELAX_TOKEN_SCOPE'] = '1'
from deps import db, require_auth, log_activity

router = APIRouter(prefix="/api/agenda/google")

# Google OAuth2 Config from environment
CLIENT_ID = os.environ.get("GOOGLE_CLIENT_ID", "").strip()
CLIENT_SECRET = os.environ.get("GOOGLE_CLIENT_SECRET", "").strip()

# Environment detection (matching auth.py)
ENV = os.environ.get('ENV', 'local').lower()
IS_PROD = ENV == 'production'

if IS_PROD:
    REDIRECT_URI = "https://mosdatabase-backend.k9pirj.easypanel.host/api/agenda/google/callback"
    FRONTEND_URL = "https://mosdatabase-frontend.k9pirj.easypanel.host"
else:
    REDIRECT_URI = os.environ.get("GOOGLE_REDIRECT_URI", "http://localhost:8000/api/agenda/google/callback")
    FRONTEND_URL = os.environ.get("FRONTEND_URL", "http://localhost:3000").rstrip('/')

# Scopes needed for Google Calendar
SCOPES = [
    'https://www.googleapis.com/auth/calendar.events',
    'https://www.googleapis.com/auth/calendar.readonly'
]

def get_flow():
    if not CLIENT_ID or not CLIENT_SECRET:
        raise HTTPException(status_code=500, detail="Google API credentials not configured in .env")
    
    client_config = {
        "web": {
            "client_id": CLIENT_ID,
            "project_id": "mos-system-calendar",
            "auth_uri": "https://accounts.google.com/o/oauth2/auth",
            "token_uri": "https://oauth2.googleapis.com/token",
            "auth_provider_x509_cert_url": "https://www.googleapis.com/oauth2/v1/certs",
            "client_secret": CLIENT_SECRET,
            "redirect_uris": [REDIRECT_URI]
        }
    }
    return Flow.from_client_config(
        client_config,
        scopes=SCOPES,
        redirect_uri=REDIRECT_URI
    )

@router.get("/auth-url")
async def google_auth_url(request: Request):
    """Generates the Google OAuth2 authorization URL."""
    user = await require_auth(request)
    flow = get_flow()
    
    # Generate URL and state
    # We include access_type='offline' to get a refresh_token
    # include_granted_scopes='true' to allow adding scopes later
    auth_url, state = flow.authorization_url(
        access_type='offline',
        include_granted_scopes='true',
        prompt='consent' # Force consent to ensure we get a refresh token
    )
    
    # Store state in DB temporarily to verify callback (optional but safer)
    await db.google_auth_states.insert_one({
        "user_id": user["user_id"],
        "state": state,
        "created_at": datetime.now(timezone.utc).isoformat()
    })
    
    return {"url": auth_url}

@router.get("/callback")
async def google_callback(request: Request, code: str, state: str):
    """Callback for Google OAuth2. Receives code and state."""
    # Note: In a real app, you should verify the state against the one stored in DB
    # For now, we fetch the user by state if possible or just assume current user
    # Since this is a browser redirect, we might not have the session cookie easily 
    # depending on SameSite settings. We'll try to get user from state.
    
    state_doc = await db.google_auth_states.find_one({"state": state})
    if not state_doc:
        raise HTTPException(status_code=400, detail="Invalid auth state or session expired")
    
    user_id = state_doc["user_id"]
    
    flow = get_flow()
    flow.fetch_token(code=code)
    credentials = flow.credentials
    
    # Convert credentials to a dictionary to store
    creds_data = {
        'token': credentials.token,
        'refresh_token': credentials.refresh_token,
        'token_uri': credentials.token_uri,
        'client_id': credentials.client_id,
        'client_secret': credentials.client_secret,
        'scopes': credentials.scopes,
        'expiry': credentials.expiry.isoformat() if credentials.expiry else None
    }
    
    # Store tokens in DB
    await db.user_google_tokens.update_one(
        {"user_id": user_id},
        {"$set": {
            "user_id": user_id,
            "credentials": creds_data,
            "updated_at": datetime.now(timezone.utc).isoformat()
        }},
        upsert=True
    )
    
    # Clean up state
    await db.google_auth_states.delete_one({"state": state})
    
    # Redirect back to frontend agenda
    return RedirectResponse(url=f"{FRONTEND_URL}/agenda?google_connected=true")

@router.get("/status")
async def google_status(request: Request):
    """Checks if the user has a Google account connected."""
    user = await require_auth(request)
    token_doc = await db.user_google_tokens.find_one({"user_id": user["user_id"]})
    return {"connected": token_doc is not None}

@router.get("/disconnect")
async def google_disconnect(request: Request):
    """Removes Google integration for the user."""
    user = await require_auth(request)
    await db.user_google_tokens.delete_one({"user_id": user["user_id"]})
    await log_activity(user, "google_calendar_disconnected")
    return {"status": "disconnected"}

@router.get("/sync")
async def sync_google_events(request: Request):
    """Fetches events from Google and merges them with local view (doesn't persist to local DB for now, just proxy)."""
    user = await require_auth(request)
    token_doc = await db.user_google_tokens.find_one({"user_id": user["user_id"]})
    
    if not token_doc:
        return {"events": [], "connected": False}
    
    creds_data = token_doc["credentials"]
    
    # Parse expiry back to datetime if it exists
    expiry = None
    if creds_data.get('expiry'):
        try:
            # Google auth library compares with naive utcnow(), so we make it naive
            expiry = datetime.fromisoformat(creds_data['expiry'])
            if expiry.tzinfo is not None:
                expiry = expiry.replace(tzinfo=None)
        except:
            pass

    creds = Credentials(
        token=creds_data['token'],
        refresh_token=creds_data.get('refresh_token'),
        token_uri=creds_data['token_uri'],
        client_id=creds_data['client_id'],
        client_secret=creds_data['client_secret'],
        scopes=creds_data['scopes'],
        expiry=expiry
    )
    
    try:
        # Refresh token if expired
        if creds.expired and creds.refresh_token:
            creds.refresh(GoogleRequest())
            # Update stored tokens
            creds_data['token'] = creds.token
            creds_data['expiry'] = creds.expiry.isoformat() if creds.expiry else None
            await db.user_google_tokens.update_one(
                {"user_id": user["user_id"]},
                {"$set": {"credentials": creds_data, "updated_at": datetime.now(timezone.utc).isoformat()}}
            )
    except Exception as e:
        # If refresh fails, user might need to re-connect
        return {"events": [], "connected": True, "error": f"Token refresh failed: {str(e)}", "needs_reconnect": True}

    try:
        service = build('calendar', 'v3', credentials=creds)
        
        # Get events from last 30 days and next 90 days
        time_min = (datetime.now(timezone.utc) - timedelta(days=30)).isoformat().replace('+00:00', 'Z')
        
        events_result = service.events().list(
            calendarId='primary', 
            timeMin=time_min,
            maxResults=250, 
            singleEvents=True,
            orderBy='startTime'
        ).execute()
        
        g_events = events_result.get('items', [])
    except Exception as e:
        return {"events": [], "connected": True, "error": f"Google API call failed: {str(e)}"}
    
    logging.info(f"GOOGLE_CALENDAR: Found {len(g_events)} events for user {user['user_id']}")
    
    # Transform to our internal format
    formatted_events = []
    for ge in g_events:
        start = ge['start'].get('dateTime', ge['start'].get('date'))
        end = ge['end'].get('dateTime', ge['end'].get('date'))
        
        formatted_events.append({
            "event_id": f"google_{ge['id']}",
            "title": ge.get('summary', '(Sin título)'),
            "description": ge.get('description', ''),
            "start_dt": start,
            "end_dt": end,
            "all_day": 'date' in ge['start'],
            "category": "google",
            "color": "#4285F4",
            "location": ge.get('location', ''),
            "is_google": True,
            "html_link": ge.get('htmlLink')
        })
        
async def get_google_service(user_id: str):
    """Helper to get an authenticated Google Calendar service for a user."""
    token_doc = await db.user_google_tokens.find_one({"user_id": user_id})
    if not token_doc:
        return None
    
    creds_data = token_doc["credentials"]
    expiry = None
    if creds_data.get('expiry'):
        try:
            expiry = datetime.fromisoformat(creds_data['expiry']).replace(tzinfo=None)
        except: pass

    creds = Credentials(
        token=creds_data['token'],
        refresh_token=creds_data.get('refresh_token'),
        token_uri=creds_data['token_uri'],
        client_id=creds_data['client_id'],
        client_secret=creds_data['client_secret'],
        scopes=creds_data['scopes'],
        expiry=expiry
    )

    try:
        if creds.expired and creds.refresh_token:
            creds.refresh(GoogleRequest())
            creds_data['token'] = creds.token
            creds_data['expiry'] = creds.expiry.isoformat() if creds.expiry else None
            await db.user_google_tokens.update_one(
                {"user_id": user_id},
                {"$set": {"credentials": creds_data, "updated_at": datetime.now(timezone.utc).isoformat()}}
            )
        return build('calendar', 'v3', credentials=creds)
    except:
        return None

async def create_google_event(user_id: str, event_data: dict):
    """Pushes a new MOS event to Google Calendar."""
    service = await get_google_service(user_id)
    if not service: return None
    
    g_event = {
        'summary': event_data['title'],
        'location': event_data.get('location', ''),
        'description': event_data.get('description', ''),
        'start': {
            'dateTime': event_data['start_dt'] + ":00" if "T" in event_data['start_dt'] else None,
            'date': event_data['start_dt'] if "T" not in event_data['start_dt'] else None,
            'timeZone': 'UTC',
        },
        'end': {
            'dateTime': event_data['end_dt'] + ":00" if "T" in event_data['end_dt'] else None,
            'date': event_data['end_dt'] if "T" not in event_data['end_dt'] else None,
            'timeZone': 'UTC',
        },
        'reminders': {'useDefault': True},
    }
    
    try:
        created = service.events().insert(calendarId='primary', body=g_event).execute()
        return created.get('id')
    except Exception as e:
        print(f"Error creating google event: {e}")
        return None

async def update_google_event(user_id: str, google_event_id: str, event_data: dict):
    """Updates an existing Google event from MOS."""
    service = await get_google_service(user_id)
    if not service or not google_event_id: return False
    
    g_event = {
        'summary': event_data.get('title'),
        'location': event_data.get('location', ''),
        'description': event_data.get('description', ''),
        'start': {
            'dateTime': event_data['start_dt'] + ":00" if "T" in event_data['start_dt'] else None,
            'date': event_data['start_dt'] if "T" not in event_data['start_dt'] else None,
            'timeZone': 'UTC',
        },
        'end': {
            'dateTime': event_data['end_dt'] + ":00" if "T" in event_data['end_dt'] else None,
            'date': event_data['end_dt'] if "T" not in event_data['end_dt'] else None,
            'timeZone': 'UTC',
        },
    }
    # Remove None values
    g_event = {k: v for k, v in g_event.items() if v is not None}

    try:
        service.events().patch(calendarId='primary', eventId=google_event_id, body=g_event).execute()
        return True
    except:
        return False

async def delete_google_event(user_id: str, google_event_id: str):
    """Deletes a Google event when removed from MOS."""
    service = await get_google_service(user_id)
    if not service or not google_event_id: return False
    try:
        service.events().delete(calendarId='primary', eventId=google_event_id).execute()
        return True
    except:
        return False
