import time
import threading
from datetime import datetime, timedelta, timezone
from typing import Dict, Any, Optional
from apscheduler.schedulers.background import BackgroundScheduler
from scraper import scrape_sync, get_live_state
import database

scheduler: Optional[BackgroundScheduler] = None
_is_scraping = False
_last_run_time: Optional[datetime] = None
_next_run_time: Optional[datetime] = None

def _scheduled_job():
    global _is_scraping, _last_run_time, _next_run_time
    if _is_scraping:
        print("[Scheduler] Scraper already running, skipping trigger.")
        return

    _is_scraping = True
    try:
        print(f"[Scheduler] Triggering scheduled scrape at {datetime.now(timezone.utc).isoformat()}...")
        res = scrape_sync()
        _last_run_time = datetime.now(timezone.utc)
        _next_run_time = _last_run_time + timedelta(hours=1)
        print(f"[Scheduler] Scrape job finished. Result: {res}")
    except Exception as e:
        print(f"[Scheduler] Error during scheduled scrape: {e}")
    finally:
        _is_scraping = False

def start_scheduler():
    global scheduler, _next_run_time
    if scheduler is not None and scheduler.running:
        return scheduler

    scheduler = BackgroundScheduler(daemon=True)
    scheduler.add_job(
        _scheduled_job,
        trigger="interval",
        hours=1,
        id="statsarena_hourly_scraper",
        name="Hourly StatsArena Sitemap Scraper",
        replace_existing=True
    )
    scheduler.start()
    _next_run_time = datetime.now(timezone.utc) + timedelta(hours=1)
    print("[Scheduler] Hourly background scraper initialized (interval: 1 hour).")
    return scheduler

def trigger_manual_scrape() -> Dict[str, Any]:
    global _is_scraping
    if _is_scraping or get_live_state().get("is_running"):
        return {"status": "already_running", "message": "Scraper is currently running"}

    def run_async_wrapper():
        global _is_scraping, _last_run_time, _next_run_time
        _is_scraping = True
        try:
            scrape_sync()
            _last_run_time = datetime.now(timezone.utc)
            _next_run_time = _last_run_time + timedelta(hours=1)
        except Exception as e:
            print(f"[Manual Trigger] Scraper error: {e}")
        finally:
            _is_scraping = False

    t = threading.Thread(target=run_async_wrapper, daemon=True)
    t.start()
    return {"status": "started", "message": "Scraper job started in background"}

def get_scheduler_status() -> Dict[str, Any]:
    stats = database.get_stats()
    job = scheduler.get_job("statsarena_hourly_scraper") if scheduler else None
    next_fire = job.next_run_time.isoformat() if job and job.next_run_time else None
    live = get_live_state()

    return {
        "is_running": live.get("is_running") or _is_scraping,
        "live_state": live,
        "scheduler_active": scheduler.running if scheduler else False,
        "interval_hours": 1,
        "last_run": _last_run_time.isoformat() if _last_run_time else (stats.get("last_run", {}).get("timestamp") if stats.get("last_run") else None),
        "next_run": next_fire,
        "stats": stats
    }
