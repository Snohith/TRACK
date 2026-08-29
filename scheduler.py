import threading
import logging
from datetime import datetime, timedelta, timezone
from typing import Dict, Any, Optional
from apscheduler.schedulers.background import BackgroundScheduler
from scraper import scrape_sync, get_live_state
import database

logger = logging.getLogger(__name__)

_scheduler: Optional[BackgroundScheduler] = None
_lock = threading.Lock()
_is_scraping = False
_last_run_time: Optional[datetime] = None


def _scheduled_job():
    global _is_scraping, _last_run_time

    with _lock:
        if _is_scraping:
            logger.info("[Scheduler] Scraper already running, skipping trigger.")
            return
        _is_scraping = True

    try:
        logger.info(f"[Scheduler] Triggering scheduled scrape at {datetime.now(timezone.utc).isoformat()}")
        res = scrape_sync()
        _last_run_time = datetime.now(timezone.utc)
        logger.info(f"[Scheduler] Scrape job finished. Result: {res}")
    except Exception as e:
        logger.error(f"[Scheduler] Error during scheduled scrape: {e}", exc_info=True)
    finally:
        with _lock:
            _is_scraping = False


def start_scheduler() -> BackgroundScheduler:
    global _scheduler

    if _scheduler is not None and _scheduler.running:
        return _scheduler

    _scheduler = BackgroundScheduler(daemon=True)
    _scheduler.add_job(
        _scheduled_job,
        trigger="interval",
        minutes=10,
        id="statsarena_10min_scraper",
        name="10-Minute StatsArena Scraper & Result Resolver",
        replace_existing=True,
        max_instances=1,
        coalesce=True,
    )
    _scheduler.start()
    logger.info("[Scheduler] Background scraper initialized (interval: 10 minutes).")
    return _scheduler


def trigger_manual_scrape() -> Dict[str, Any]:
    global _is_scraping

    with _lock:
        if _is_scraping or get_live_state().get("is_running"):
            return {"status": "already_running", "message": "Scraper is currently running"}

    def _run_wrapper():
        global _is_scraping, _last_run_time
        with _lock:
            _is_scraping = True
        try:
            scrape_sync()
            _last_run_time = datetime.now(timezone.utc)
        except Exception as e:
            logger.error(f"[Manual Trigger] Scraper error: {e}", exc_info=True)
        finally:
            with _lock:
                _is_scraping = False

    t = threading.Thread(target=_run_wrapper, daemon=True, name="manual-scraper")
    t.start()
    return {"status": "started", "message": "Scraper job started in background"}


def get_scheduler_status() -> Dict[str, Any]:
    stats = database.get_stats()
    job = _scheduler.get_job("statsarena_hourly_scraper") if _scheduler else None
    next_fire = job.next_run_time.isoformat() if job and job.next_run_time else None
    live = get_live_state()

    # Determine last_run from module state or DB fallback
    last_run_iso = None
    if _last_run_time:
        last_run_iso = _last_run_time.isoformat()
    elif stats.get("last_run") and isinstance(stats["last_run"], dict):
        last_run_iso = stats["last_run"].get("timestamp")

    return {
        "is_running": live.get("is_running") or _is_scraping,
        "live_state": live,
        "scheduler_active": _scheduler.running if _scheduler else False,
        "interval_hours": 1,
        "last_run": last_run_iso,
        "next_run": next_fire,
        "stats": stats
    }
