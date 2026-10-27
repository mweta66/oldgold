"""Read-only MT5 connection probe. Never reads account credentials or places orders."""
import argparse
import json
import os
from pathlib import Path
import sys
import time
import math
import subprocess


def terminal_path():
    candidates = [
        Path(os.environ.get("PROGRAMFILES", "C:/Program Files")) / "MetaTrader 5" / "terminal64.exe",
        Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / "MetaTrader 5" / "terminal64.exe",
    ]
    return str(next((path for path in candidates if path.is_file()), candidates[0]))


def inspect(mt5, terminal, symbol=None):
    if not Path(terminal).is_file():
        return {"ok": False, "code": "MT5_NOT_INSTALLED"}
    if not mt5.initialize(terminal, timeout=10000):
        return {"ok": False, "code": "MT5_CONNECTION_UNAVAILABLE"}
    try:
        info = mt5.terminal_info()
        if info is None or not info.connected:
            return {"ok": False, "code": "LOGIN_REQUIRED_IN_MT5"}
        if not symbol:
            candidates = sorted(s.name for s in (mt5.symbols_get() or ())
                                if "XAU" in s.name.upper() or "GOLD" in s.name.upper())
            return {"ok": True, "connected": True, "goldSymbols": candidates}
        if mt5.symbol_info(symbol) is None:
            return {"ok": False, "code": "SYMBOL_NOT_FOUND"}
        if not mt5.symbol_select(symbol, True):
            return {"ok": False, "code": "SYMBOL_NOT_AVAILABLE"}
        tick = mt5.symbol_info_tick(symbol)
        # The first subscription may need a few seconds to receive its first tick.
        deadline = time.monotonic() + 5
        while (tick is None or tick.bid <= 0 or tick.ask <= 0 or tick.time_msc <= 0) and time.monotonic() < deadline:
            time.sleep(0.5)
            tick = mt5.symbol_info_tick(symbol)
        if tick is None or not all(math.isfinite(x) and x>0 for x in (tick.bid, tick.ask)) or tick.ask<tick.bid or tick.time_msc<=0:
            return {"ok": False, "code": "WAITING_FOR_QUOTE"}
        age_ms = max(0, int(time.time() * 1000) - tick.time_msc)
        return {"ok": True, "connected": True, "symbol": symbol,
                "bid": tick.bid, "ask": tick.ask, "quoteTimeMs": tick.time_msc,
                "quoteAgeMs": age_ms, "fresh": age_ms <= 15000}
    finally:
        mt5.shutdown()


def main():
    parser = argparse.ArgumentParser(description="Read MT5 connectivity and gold symbols only")
    parser.add_argument("--terminal", default=terminal_path())
    parser.add_argument("--symbol")
    parser.add_argument("--worker", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    if not args.worker:
        command = [sys.executable, str(Path(__file__).resolve()), "--worker", "--terminal", args.terminal]
        if args.symbol:
            command += ["--symbol", args.symbol]
        process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        try:
            output, _ = process.communicate(timeout=20)
            print(output.strip() or json.dumps({"ok":False,"code":"MT5_PROBE_FAILED"}))
            return process.returncode or 0
        except subprocess.TimeoutExpired:
            process.kill()
            process.communicate()
            print(json.dumps({"ok":False,"code":"MT5_READER_TIMEOUT"}))
            return 1
    try:
        import MetaTrader5 as mt5
        report = inspect(mt5, args.terminal, args.symbol)
    except ImportError:
        report = {"ok": False, "code": "MT5_PYTHON_PACKAGE_MISSING"}
    except Exception:
        # SDK errors can contain local/account details. Do not print them.
        report = {"ok": False, "code": "MT5_PROBE_FAILED"}
    print(json.dumps(report, ensure_ascii=False))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
