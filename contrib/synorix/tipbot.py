#!/usr/bin/env python3
"""Synorix Telegram tip bot.

Custodial off-chain tip ledger backed by the SNRX reserve:
- /faucet is a ONE-TIME welcome bonus; /tip is instant free off-chain transfer.
- /invite gives a referral link; when an invitee claims their welcome bonus,
  both the inviter and invitee get a referral reward.
- /withdraw pays out on-chain from the reserve via the AMM executor.
Pure stdlib (long polling); token + config come from env.
"""
import json, os, time, threading, urllib.request, urllib.parse

TOKEN = os.environ["TG_BOT_TOKEN"]
API = "https://api.telegram.org/bot" + TOKEN
LEDGER = os.environ.get("TIPBOT_LEDGER", "/root/synorix-tipbot-ledger.json")
EXEC = os.environ.get("EXEC_URL", "http://127.0.0.1:3002")
BOT_USERNAME = os.environ.get("BOT_USERNAME", "SynorixCoinBot")
FAUCET = float(os.environ.get("FAUCET_AMOUNT", "5"))          # one-time welcome
REFERRAL = float(os.environ.get("REFERRAL_BONUS", "5"))       # paid to both sides
MIN_WITHDRAW = float(os.environ.get("MIN_WITHDRAW", "25"))
_lock = threading.Lock()


def api(method, **params):
    data = urllib.parse.urlencode(params).encode()
    req = urllib.request.Request(API + "/" + method, data=data)
    with urllib.request.urlopen(req, timeout=70) as r:
        return json.loads(r.read())


def send(chat_id, text, reply_to=None):
    p = {"chat_id": chat_id, "text": text}
    if reply_to:
        p["reply_to_message_id"] = reply_to
    try:
        api("sendMessage", **p)
    except Exception as e:
        print("send err", e)


def load():
    with _lock:
        try:
            with open(LEDGER) as f:
                return json.load(f)
        except Exception:
            return {}


def save(d):
    with _lock:
        tmp = LEDGER + ".tmp"
        with open(tmp, "w") as f:
            json.dump(d, f)
        os.replace(tmp, LEDGER)


def exec_send(to, amount):
    req = urllib.request.Request(
        EXEC + "/send",
        data=json.dumps({"to": to, "amount": amount}).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=90) as r:
        return json.loads(r.read())


def rec(d, uid, username=None):
    u = d.setdefault(str(uid), {"balance": 0.0, "username": None, "last_faucet": 0})
    if username:
        u["username"] = username
    return u


def fmt(n):
    s = f"{n:,.4f}".rstrip("0").rstrip(".")
    return s if s else "0"


HELP = (
    "Synorix Tip Bot \U0001FA99\n\n"
    "/faucet — one-time welcome bonus\n"
    "/balance — your tip balance\n"
    "/tip <amount> — reply to someone to tip them\n"
    "/invite — get your referral link (earn when friends join)\n"
    "/withdraw <snrx1...> <amount> — send to your wallet\n\n"
    "Tips are instant and free. Withdrawals go on-chain."
)


def handle(msg):
    text = (msg.get("text") or "").strip()
    if not text.startswith("/"):
        return
    chat_id = msg["chat"]["id"]
    frm = msg["from"]
    uid = frm["id"]
    uname = frm.get("username")
    mid = msg["message_id"]
    parts = text.split()
    cmd = parts[0].split("@")[0].lower()

    d = load()
    me = rec(d, uid, uname)

    if cmd in ("/start", "/help"):
        # Referral capture: only for a genuinely new user arriving via a link.
        if cmd == "/start" and len(parts) >= 2:
            ref = parts[1]
            if (me["balance"] == 0 and me.get("last_faucet", 0) == 0
                    and not me.get("referrer") and ref.isdigit()
                    and ref != str(uid) and ref in d):
                me["referrer"] = ref
                save(d)
        extra = "\n\n\U0001F381 You were invited! Use /faucet to claim your welcome bonus — your inviter earns a reward too." if me.get("referrer") else ""
        send(chat_id, HELP + extra, mid)
        return

    if cmd == "/balance":
        send(chat_id, f"\U0001F4B0 Your balance: {fmt(me['balance'])} SNRX", mid)
        return

    if cmd == "/invite":
        link = f"https://t.me/{BOT_USERNAME}?start={uid}"
        send(chat_id, f"\U0001F517 Your invite link:\n{link}\n\nWhen a friend joins and claims their welcome bonus, you BOTH get {fmt(REFERRAL)} SNRX.", mid)
        return

    if cmd == "/faucet":
        if me.get("last_faucet", 0) > 0:
            send(chat_id, "\U0001F381 You've already claimed your one-time welcome bonus.", mid)
            return
        me["balance"] += FAUCET
        me["last_faucet"] = int(time.time())
        reffer = me.get("referrer")
        if reffer and not me.get("ref_paid") and reffer in d and reffer != str(uid):
            d[reffer]["balance"] = d[reffer].get("balance", 0.0) + REFERRAL
            me["balance"] += REFERRAL  # invitee also gets the referral bonus
            me["ref_paid"] = True
            save(d)
            send(chat_id, f"\U0001F6B0 Welcome + referral bonus: +{fmt(FAUCET + REFERRAL)} SNRX! Balance: {fmt(me['balance'])} SNRX", mid)
            try:
                send(int(reffer), f"\U0001F389 Someone joined with your invite link! +{fmt(REFERRAL)} SNRX added to your balance.")
            except Exception:
                pass
        else:
            save(d)
            send(chat_id, f"\U0001F6B0 Welcome bonus: +{fmt(FAUCET)} SNRX! Balance: {fmt(me['balance'])} SNRX\nTip with /tip or invite friends with /invite.", mid)
        return

    if cmd == "/tip":
        reply = msg.get("reply_to_message")
        if not reply or "from" not in reply:
            send(chat_id, "Reply to someone's message with: /tip <amount>", mid)
            return
        target = reply["from"]
        if target.get("is_bot"):
            send(chat_id, "Can't tip a bot.", mid)
            return
        if target["id"] == uid:
            send(chat_id, "You can't tip yourself \U0001F642", mid)
            return
        if len(parts) < 2:
            send(chat_id, "Usage: reply to a message + /tip <amount>", mid)
            return
        try:
            amt = float(parts[1])
        except ValueError:
            send(chat_id, "Invalid amount.", mid)
            return
        if amt <= 0:
            send(chat_id, "Amount must be positive.", mid)
            return
        if me["balance"] < amt:
            send(chat_id, f"Not enough balance ({fmt(me['balance'])} SNRX). Try /faucet or /invite.", mid)
            return
        tgt = rec(d, target["id"], target.get("username"))
        me["balance"] -= amt
        tgt["balance"] += amt
        save(d)
        tname = "@" + target["username"] if target.get("username") else target.get("first_name", "user")
        send(chat_id, f"✅ {fmt(amt)} SNRX tipped to {tname}!", mid)
        return

    if cmd == "/withdraw":
        if len(parts) < 3:
            send(chat_id, "Usage: /withdraw <snrx1address> <amount>", mid)
            return
        addr = parts[1]
        try:
            amt = float(parts[2])
        except ValueError:
            send(chat_id, "Invalid amount.", mid)
            return
        if not (addr.startswith("snrx1") or addr.startswith("tsnrx1")):
            send(chat_id, "Enter a valid SNRX address (snrx1...).", mid)
            return
        if amt < MIN_WITHDRAW:
            send(chat_id, f"Minimum withdrawal is {fmt(MIN_WITHDRAW)} SNRX.", mid)
            return
        if me["balance"] < amt:
            send(chat_id, f"Not enough balance ({fmt(me['balance'])} SNRX).", mid)
            return
        me["balance"] -= amt
        save(d)
        try:
            res = exec_send(addr, round(amt, 8))
            if res.get("error"):
                raise RuntimeError(res["error"])
            send(chat_id, f"✅ Sent {fmt(amt)} SNRX on-chain!\nTx: {res.get('txid', '?')}", mid)
        except Exception as e:
            d2 = load()
            rec(d2, uid)["balance"] += amt
            save(d2)
            send(chat_id, f"❌ Withdrawal failed, balance refunded. ({e})", mid)
        return


def main():
    print("Synorix tip bot starting…")
    offset = 0
    while True:
        try:
            r = api("getUpdates", offset=offset, timeout=60)
            for upd in r.get("result", []):
                offset = upd["update_id"] + 1
                m = upd.get("message") or upd.get("edited_message")
                if m:
                    try:
                        handle(m)
                    except Exception as e:
                        print("handle err", e)
        except Exception as e:
            print("poll err", e)
            time.sleep(3)


if __name__ == "__main__":
    main()
