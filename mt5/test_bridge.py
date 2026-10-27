import unittest
from types import SimpleNamespace
from bridge import snapshot


class FeedTests(unittest.TestCase):
    def test_stale_and_zero_quotes_never_load_or_send_history(self):
        for bid, stamp in [(0, 100000), (4000, 1000)]:
            class Fake:
                def terminal_info(self):
                    return SimpleNamespace(connected=True)
                def symbol_info_tick(self, symbol):
                    return SimpleNamespace(bid=bid, ask=4001, time_msc=stamp)
                def copy_rates_from_pos(self, *args):
                    raise AssertionError("Must not read history for invalid quotes")
            self.assertIsNone(snapshot(Fake(), {"symbol":"XAUUSD"}, 100000))

    def test_real_ohlc_and_tick_volume_are_preserved(self):
        class Fake:
            TIMEFRAME_M1 = 1
            def terminal_info(self):
                return SimpleNamespace(connected=True)
            def symbol_info_tick(self, symbol):
                return SimpleNamespace(bid=4000, ask=4001, time_msc=99999)
            def copy_rates_from_pos(self, *args):
                return [{"time":60,"open":4001,"high":4002,"low":3999,"close":4000,"tick_volume":12}]
        data=snapshot(Fake(),{"symbol":"XAUUSD","server":"MetaQuotes-Demo"},100000)
        self.assertEqual(data["bars"][0]["volume"],12)
        self.assertEqual(data["bid"],4000)
        self.assertNotIn("login",data)


if __name__ == "__main__":
    unittest.main()
