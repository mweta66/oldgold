# Stop calculation for new automatic signals

Entry and target formulas are unchanged. Select the nearest unbroken, confirmed sampled-close support (buy) or resistance (sell), formed within the last 90 minutes. Add the existing volatility buffer beyond that level to obtain the base stop. Double the distance from entry to that base stop, rounding outward to cents. Thus entry 4000/base stop 3996 becomes 3992; a sell at 4000/base stop 4004 becomes 4008.

The final stop is beyond the selected structure; it is not necessarily itself another observed pivot. The existing final distance cap of 1% of entry still applies. A missing valid structure rejects the signal. Existing signals and their stored stop/target values are untouched.

Keep the 1.2 minimum opportunity filter against the base stop to preserve the original setup selection with unchanged targets. Record both baseFirstRewardRisk and the actual firstRewardRisk after widening; actual reward/risk is half the base ratio (apart from rounding), potentially below 1.2. No lot sizing or account-risk cap is implemented by this change.

Apply migration 015_double_structure_stop.sql with the matching application code. Both the native cloud planner and the JavaScript worker use the same new calculation, independently checked by PostgreSQL parity tests. This change does not move stops on open signals, add trailing stops, or execute broker orders.
