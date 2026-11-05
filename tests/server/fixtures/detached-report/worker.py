"""Synthetic detached report worker (public test fixture) for Ekko detached completion.

Composes the day's report at most once, persists the draft as its pending delivery BEFORE
submitting, and commits business state only after Studio's receipt for the original invocation.
An ambiguous result keeps the pending draft; the next run resubmits the identical bytes under the
same event id. Slack-style links in the draft are converted to Markdown deterministically.
"""
import datetime
import json
import os
import re
import subprocess
import sys
import time

run = sys.argv[1]
state = os.environ["SYNTHETIC_REPORT_STATE"]
lock = os.path.join(state, "lock")
open(os.path.join(lock, "pid"), "w").write(str(os.getpid()))
open(os.path.join(run, "started"), "w").write(str(os.getpid()))
day_file = os.path.join(state, "day")
day = (os.environ.get("SYNTHETIC_REPORT_DAY") or (open(day_file).read().strip() if os.path.exists(day_file) else "")
       or datetime.date.today().isoformat())
event = f"synthetic-daily-report:v1:{day}"
pending = os.path.join(state, "pending.md")
ledger = os.path.join(state, "delivered.json")


def slack_links_to_markdown(text: str) -> str:
    """``<https://url|label>`` -> ``[label](https://url)``; only http(s), label brackets escaped."""
    def link(match: re.Match) -> str:
        label = re.sub(r"([\[\]\\])", r"\\\1", match.group(2))
        return f"[{label}]({match.group(1).replace('(', '%28').replace(')', '%29')})"
    return re.sub(r"<(https?://[^|>\s]+)\|([^>\n]+)>", link, text)


def compose() -> str:
    with open(os.path.join(state, "compositions"), "a") as counter:
        counter.write(f"{day}\n")
    draft = "\n".join([
        f"## Synthetic daily report {day}", "",
        "| Ticket | Status | Owner |", "| --- | --- | --- |",
        "| <https://example.com/issues/SYN-1|SYN-1> | In progress | alice |",
        "| <https://example.com/issues/SYN-2|SYN-2 [flaky]> | Done | bob |", "",
        f"Full report: <https://example.com/reports/{day}|{day}>", "",
    ])
    return slack_links_to_markdown(draft)


def main() -> int:
    hold = float(os.environ.get("SYNTHETIC_REPORT_HOLD") or 0)
    if hold:
        time.sleep(hold)
    delivered = json.load(open(ledger)) if os.path.exists(ledger) else {}
    nothing_new = event in delivered and not os.path.exists(pending)
    if not nothing_new and not os.path.exists(pending):
        temp = pending + ".tmp"
        with open(temp, "w") as handle:
            handle.write(compose())
            handle.flush()
            os.fsync(handle.fileno())
        os.rename(temp, pending)
    helper = os.environ.get("EKKO_SCRIPT_REPORT_HELPER")
    if not helper:
        print("no Ekko completion context; draft stays pending")
        return 1
    if nothing_new:
        # Nothing new today: release the handed-off invocation as silence.
        args = ["--outcome", "silent", "--content-file", os.devnull, "--event-id", f"noop:{os.environ['EKKO_SCRIPT_REPORT_INVOCATION']}"]
    else:
        args = ["--event-id", event, "--content-file", pending]
    wait_file = os.path.join(state, "wait")
    wait = os.environ.get("SYNTHETIC_REPORT_WAIT") or (open(wait_file).read().strip() if os.path.exists(wait_file) else "0")
    result = subprocess.run([os.environ["EKKO_SCRIPT_REPORT_PYTHON"], helper, "complete", *args, "--wait", wait],
                            capture_output=True, text=True)
    print(f"helper exit {result.returncode}: {result.stdout.strip()} {result.stderr.strip()}")
    answer = json.loads(result.stdout or "{}")
    if result.returncode == 0 and answer.get("event_id") == event and answer.get("receipt", {}).get("notification_id"):
        delivered[event] = answer["receipt"]
        with open(ledger + ".tmp", "w") as handle:
            json.dump(delivered, handle)
        os.rename(ledger + ".tmp", ledger)
        os.unlink(pending)
    return 0


try:
    sys.exit(main())
finally:
    subprocess.run(["rm", "-rf", lock])
