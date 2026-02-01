# telemetry/events.py

def log_event(event, payload=None):
    """
    Log telemetry events
    
    For now:
    - prints to console
    
    Later — file / analytics / server
    
    No filenames. No paths. No content.
    
    Args:
        event: Event name
        payload: Optional event data (dict)
    """
    payload = payload or {}
    print(f"[TELEMETRY] {event} | {payload}")
