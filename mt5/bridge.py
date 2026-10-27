"""Read-only MT5 price bridge. No login/password/order/account APIs are used."""
import argparse
import json
import math
import multiprocessing as mp
import os
from pathlib import Path
import queue
import re
import time
import urllib.error
import urllib.request
from urllib.parse import urlsplit

from check_connection import terminal_path


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def load_config(path):
    config = json.loads(Path(path).read_text(encoding="utf-8-sig"))
    url = urlsplit(config.get("origin", ""))
    if (url.scheme != "https" or url.hostname != "wetagold.vercel.app" or
            url.port not in (None, 443) or url.username or url.password or
            url.path not in ("", "/") or url.query or url.fragment):
        raise ValueError("SITE_ORIGIN_INVALID")
    if not re.fullmatch(r"[a-f0-9]{64}", config.get("token", "")):
        raise ValueError("BRIDGE_TOKEN_NOT_CONFIGURED")
    if not config.get("symbol") or not config.get("server"):
        raise ValueError("SYMBOL_OR_SERVER_MISSING")
    config["terminal"] = config.get("terminal") or terminal_path()
    return config


def snapshot(mt5, config, now_ms):
    info = mt5.terminal_info()
    if info is None or not info.connected:
        return None
    tick = mt5.symbol_info_tick(config["symbol"])
    if (tick is None or not all(math.isfinite(x) and x > 0 for x in (tick.bid, tick.ask))
            or tick.ask < tick.bid or not now_ms-15000 <= tick.time_msc <= now_ms+5000):
        return None
    rates = mt5.copy_rates_from_pos(config["symbol"], mt5.TIMEFRAME_M1, 0, 600)
    if rates is None or len(rates) == 0:
        return None
    bars = [{"time": int(r["time"]), "open": float(r["open"]),
             "high": float(r["high"]), "low": float(r["low"]),
             "close": float(r["close"]), "volume": int(r["tick_volume"])} for r in rates]
    return {"symbol": config["symbol"], "server": config["server"],
            "timeMs": int(tick.time_msc), "observedMs": now_ms,
            "bid": float(tick.bid), "ask": float(tick.ask), "bars": bars}


def worker(config, output):
    import MetaTrader5 as mt5
    try:
        if not mt5.initialize(config["terminal"], timeout=10000):
            return
        if not mt5.symbol_select(config["symbol"], True):
            return
        while True:
            data = snapshot(mt5, config, int(time.time()*1000))
            # Replace an old sample; never build up delayed market data.
            try:
                output.put(data, timeout=0.05)
            except queue.Full:
                try:
                    output.get_nowait()
                except queue.Empty:
                    pass
            time.sleep(1)
    finally:
        mt5.shutdown()


def send(config, data):
    request = urllib.request.Request(
        config["origin"].rstrip("/") + "/api/mt5/ingest",
        data=json.dumps(data, allow_nan=False, separators=(",", ":")).encode(),
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + config["token"]},
        method="POST")
    opener = urllib.request.build_opener(NoRedirect)
    with opener.open(request, timeout=8) as response:
        result = json.loads(response.read(2048))
        if not result.get("ok"):
            raise ValueError("INGEST_NOT_CONFIRMED")


def main():
    parser = argparse.ArgumentParser(description="Read-only MT5 to Xgold bridge")
    parser.add_argument("--config", default=str(Path(__file__).with_name("config.local.json")))
    args = parser.parse_args()
    try:
        config = load_config(args.config)
    except (ValueError, OSError, KeyError):
        print("Bridge configuration is missing or invalid. No data sent.", flush=True)
        return 1
    print("MT5 read-only bridge started. Close this window to stop.", flush=True)
    process = None
    last_status = None
    seeded = False
    retry = 1
    try:
        while True:
            output = mp.Queue(maxsize=2)
            # Never pass the cloud token into the SDK worker process.
            reader_config = {k: config[k] for k in ("terminal", "symbol", "server")}
            process = mp.Process(target=worker, args=(reader_config, output), daemon=True)
            process.start()
            try:
                while process.is_alive():
                    try:
                        data = output.get(timeout=20)
                    except queue.Empty:
                        print("MT5 did not respond. Restarting the reader.", flush=True)
                        break
                    if data is None or int(time.time()*1000)-data["timeMs"] > 15000:
                        if last_status != "waiting":
                            print("Waiting for a fresh, non-zero XAUUSD quote and M1 history in MT5.", flush=True)
                        last_status = "waiting"
                        continue
                    bars = data.pop("bars")
                    chunks = [bars[i:i+80] for i in range(0, len(bars), 80)] if not seeded else [bars[-2:]]
                    try:
                        for chunk in chunks:
                            if int(time.time()*1000)-data["timeMs"] > 15000:
                                raise ValueError("SAMPLE_EXPIRED")
                            send(config, {**data, "bars": chunk})
                        seeded = True
                        retry = 1
                        if last_status != "sending":
                            print("Fresh MT5 prices are reaching the website.", flush=True)
                        last_status = "sending"
                    except (OSError, ValueError, urllib.error.URLError):
                        if last_status != "network":
                            print("Website did not confirm delivery. Retrying without replaying old quotes.", flush=True)
                        last_status = "network"
                        time.sleep(retry)
                        retry = min(30, retry*2)
            finally:
                if process.is_alive():
                    process.terminate()
                process.join(timeout=5)
                output.close()
            time.sleep(3)
    except KeyboardInterrupt:
        print("Bridge stopped.", flush=True)
        return 0
    finally:
        if process is not None and process.is_alive():
            process.terminate()
            process.join(timeout=5)


if __name__ == "__main__":
    mp.freeze_support()
    raise SystemExit(main())
