import unittest
from types import SimpleNamespace
from bridge import snapshot


class FeedTests(unittest.TestCase):
    def test_stale_and_zero_quotes_never_load_or_send_history(self):
        for bid, stamp in [(0, 100000), (4000, 1000)]:
            class Fake:
                def terminal_info(self):
                    return SimpleNamespace(connected=True)
                def account_info(self):
                    return SimpleNamespace(server="MetaQuotes-Demo")
                def symbol_info_tick(self, symbol):
                    return SimpleNamespace(bid=bid, ask=4001, time_msc=stamp)
                def copy_rates_from_pos(self, *args):
                    raise AssertionError("Must not read history for invalid quotes")
            self.assertIsNone(snapshot(Fake(), {"symbol":"XAUUSD","server":"MetaQuotes-Demo"}, 100000))

    def test_real_ohlc_and_tick_volume_are_preserved(self):
        class Fake:
            TIMEFRAME_M1 = 1
            def terminal_info(self):
                return SimpleNamespace(connected=True)
            def account_info(self):
                return SimpleNamespace(server="MetaQuotes-Demo")
            def symbol_info_tick(self, symbol):
                return SimpleNamespace(bid=4000, ask=4001, time_msc=99999)
            def copy_rates_from_pos(self, *args):
                return [{"time":60,"open":4001,"high":4002,"low":3999,"close":4000,"tick_volume":12}]
        data=snapshot(Fake(),{"symbol":"XAUUSD","server":"MetaQuotes-Demo"},100000)
        self.assertEqual(data["bars"][0]["volume"],12)
        self.assertEqual(data["bid"],4000)
        self.assertNotIn("login",data)

    def test_changing_broker_server_stops_the_feed(self):
        class Fake:
            def terminal_info(self):
                return SimpleNamespace(connected=True)
            def account_info(self):
                return SimpleNamespace(server="Another-Broker")
            def symbol_info_tick(self, symbol):
                raise AssertionError("Must not collect prices from another server")
        self.assertIsNone(snapshot(Fake(), {"symbol":"XAUUSD","server":"MetaQuotes-Demo"}, 100000))

    def test_auto_server_binds_once_and_refuses_a_later_account_switch(self):
        class Fake:
            TIMEFRAME_M1 = 1
            server = "Owner-Broker"
            def terminal_info(self):
                return SimpleNamespace(connected=True)
            def account_info(self):
                return SimpleNamespace(server=self.server)
            def symbol_info_tick(self, symbol):
                return SimpleNamespace(bid=4000, ask=4001, time_msc=99999)
            def copy_rates_from_pos(self, *args):
                return [{"time":60,"open":4001,"high":4002,"low":3999,"close":4000,"tick_volume":12}]
        fake=Fake()
        config={"symbol":"xauusd.s","server":"AUTO"}
        data=snapshot(fake,config,100000)
        self.assertEqual(data["server"],"Owner-Broker")
        self.assertEqual(config["server"],"Owner-Broker")
        fake.server="Another-Broker"
        self.assertIsNone(snapshot(fake,config,100000))


if __name__ == "__main__":
    unittest.main()
