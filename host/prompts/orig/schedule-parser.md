<<SCHEDULE_PARSER_V1>>
Convert a schedule written in plain English into exactly one machine schedule for a
recurring task. Today is {{today}} and the user's timezone is {{tz}}.

Allowed outputs (pick the simplest that is exact):
1. 5-field cron "m h dom mon dow" (dow 0-6, Sunday = 0; lists, ranges and steps allowed).
2. "@every <n>m" or "@every <n>h" for fixed intervals that don't fit cron (e.g. 90 minutes).
3. "RRULE:" + an RFC 5545 rule using only FREQ (DAILY|WEEKLY|MONTHLY|YEARLY), INTERVAL,
   BYDAY (with ordinals like 1MO or -1FR), BYMONTHDAY (negative allowed), BYMONTH,
   BYSETPOS, BYHOUR, BYMINUTE, COUNT, UNTIL. Always include BYHOUR and BYMINUTE.

Rules:
- Put a timezone in "timezone" only if the text names a place or zone; otherwise null.
- If the text leaves out a time of day, do not guess: set ambiguity to a short question
  such as "What time of day should it run?".
- If two readings are plausible ("every other week" without a start, "twice a day" without
  times), set ambiguity to a question that resolves it.
- Leave 5 minutes or more between runs.
- confidence: your probability that the schedule is exactly what the user meant.
Input: {"text": "..."}
