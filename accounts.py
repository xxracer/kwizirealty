"""
accounts.py — System Users, company seats and the plan model.

Plans (owner model):
  free        not signed in — may open the map and look at it, but not filter
  basic       individual user
  premium     individual user with the full feature set
  enterprise  a company account: inherits to every colleague in `employees`
              and may add/remove colleagues

Firestore:
  users/{uid}      { name, email, role, subscription{plan,status}, createdAt }
  companies/{id}   { name, ownerEmail, employees[], subscription{plan,status}, createdAt }
"""

import json
import time
import urllib.error
import urllib.request
import uuid

from fastapi import HTTPException

import firebase_data as fd

PLANS = ["Basic", "Premium", "Enterprise"]
STATUSES = ["active", "trial", "expired"]


def _normalize_plan(plan) -> str:
    p = str(plan or "").strip().lower()
    if p in ("enterprise", "empresarial"):
        return "enterprise"
    if p in ("premium", "pro", "profesional"):
        return "premium"
    if p in ("basic", "básico", "basico"):
        return "basic"
    return "free"


# ── Firebase Auth (Identity Toolkit admin API) ──────────────────────────────

def _identity(path: str, payload: dict) -> dict:
    url = (
        f"https://identitytoolkit.googleapis.com/v1/projects/{fd.PROJECT}/"
        + path
    )
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode(),
        headers={
            "Authorization": f"Bearer {fd.token()}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", "replace")
        try:
            msg = json.loads(raw).get("error", {}).get("message", raw)
        except Exception:  # noqa: BLE001
            msg = raw
        raise HTTPException(status_code=400, detail=msg[:300]) from None


def create_auth_user(email: str, password: str, name: str) -> str:
    out = _identity("accounts", {
        "email": email,
        "password": password,
        "displayName": name,
        "emailVerified": True,
    })
    return out["localId"]


def delete_auth_user(uid: str) -> None:
    _identity("accounts:delete", {"localId": uid})


# ── users ───────────────────────────────────────────────────────────────────

def list_users() -> list[dict]:
    users = fd._fs_list("users")
    users.sort(key=lambda u: -(float(u.get("createdAt") or 0)))
    return users


def find_user_by_email(email: str) -> dict | None:
    email = (email or "").lower()
    for u in list_users():
        if (u.get("email") or "").lower() == email:
            return u
    return None


def create_user(email: str, password: str, name: str, role: str = "user",
                plan: str = "Basic", status: str = "active") -> dict:
    email = (email or "").strip().lower()
    if not email or "@" not in email:
        raise HTTPException(status_code=400, detail="A valid email is required")
    if len(password or "") < 8:
        raise HTTPException(status_code=400, detail="The password needs at least 8 characters")
    if find_user_by_email(email):
        raise HTTPException(status_code=400, detail="That email already has a profile")

    uid = create_auth_user(email, password, name or email.split("@")[0])
    profile = {
        "name": name or "",
        "email": email,
        "role": "admin" if role == "admin" else "user",
        "subscription": {"plan": plan, "status": status},
        "createdAt": int(time.time() * 1000),
    }
    try:
        fd.fs_write("users", uid, profile)
    except Exception:
        delete_auth_user(uid)  # roll back the orphan account
        raise
    return {"id": uid, **profile}


def update_user(uid: str, patch: dict) -> dict:
    allowed = {}
    if "name" in patch:
        allowed["name"] = str(patch["name"])
    if "role" in patch:
        allowed["role"] = "admin" if patch["role"] == "admin" else "user"
    if "plan" in patch or "status" in patch:
        current = next((u for u in list_users() if u.get("_id") == uid), {})
        sub = dict(current.get("subscription") or {})
        if "plan" in patch:
            sub["plan"] = str(patch["plan"])
        if "status" in patch:
            sub["status"] = str(patch["status"])
        allowed["subscription"] = sub
    if not allowed:
        raise HTTPException(status_code=400, detail="Nothing to update")
    fd.fs_write("users", uid, allowed, merge=True)
    return {"ok": True, "id": uid}


def delete_user(uid: str) -> None:
    try:
        delete_auth_user(uid)
    except Exception:  # noqa: BLE001 - the profile may outlive a missing auth user
        pass
    fd.fs_delete("users", uid)


# ── companies ───────────────────────────────────────────────────────────────

def list_companies() -> list[dict]:
    companies = fd._fs_list("companies")
    companies.sort(key=lambda c: -(float(c.get("createdAt") or 0)))
    return companies


def create_company(name: str, owner_email: str, plan: str = "Enterprise",
                   status: str = "active", employees: list[str] | None = None) -> dict:
    name = (name or "").strip()
    owner_email = (owner_email or "").strip().lower()
    if not name or "@" not in owner_email:
        raise HTTPException(status_code=400, detail="Company name and owner email are required")
    seats = {owner_email}
    for e in employees or []:
        e = str(e).strip().lower()
        if "@" in e:
            seats.add(e)
    record = {
        "name": name,
        "ownerEmail": owner_email,
        "employees": sorted(seats),
        "subscription": {"plan": plan or "Enterprise", "status": status or "active"},
        "createdAt": int(time.time() * 1000),
    }
    doc_id = fd.fs_write("companies", f"company-{int(time.time())}-{uuid.uuid4().hex[:6]}", record)
    return {"id": doc_id, **record}


def add_employee(company_id: str, email: str) -> dict:
    email = (email or "").strip().lower()
    if "@" not in email:
        raise HTTPException(status_code=400, detail="A valid email is required")
    company = next((c for c in list_companies() if c.get("_id") == company_id), None)
    if not company:
        raise HTTPException(status_code=404, detail="Company not found")
    seats = sorted(set((company.get("employees") or []) + [email]))
    fd.fs_write("companies", company_id, {"employees": seats}, merge=True)
    return {"ok": True, "employees": seats}


def remove_employee(company_id: str, email: str) -> dict:
    email = (email or "").strip().lower()
    company = next((c for c in list_companies() if c.get("_id") == company_id), None)
    if not company:
        raise HTTPException(status_code=404, detail="Company not found")
    if email == (company.get("ownerEmail") or "").lower():
        raise HTTPException(status_code=400, detail="The owner cannot be removed")
    seats = [e for e in (company.get("employees") or []) if e.lower() != email]
    fd.fs_write("companies", company_id, {"employees": seats}, merge=True)
    return {"ok": True, "employees": seats}


def update_company_subscription(company_id: str, plan: str, status: str) -> dict:
    fd.fs_write(
        "companies", company_id,
        {"subscription": {"plan": plan, "status": status}},
        merge=True,
    )
    return {"ok": True}


def delete_company(company_id: str) -> None:
    fd.fs_delete("companies", company_id)


# ── plan resolution ─────────────────────────────────────────────────────────

def _admins() -> set[str]:
    raw = fd._env("NEXT_PUBLIC_CMS_ALLOWED_EMAILS") or ""
    return {e.strip().lower() for e in raw.split(",") if e.strip()}


# ── the access-control switch (cms_config/auth) ─────────────────────────────

_GATE = {"at": 0.0, "value": None}
GATE_TTL = 5.0


def get_gate() -> dict:
    """The live switch the owner flips from the CMS.

    userManagementEnabled = False (MVP default) → the map is OPEN: everybody
    sees every filter/report for free. True → the plan model applies.
    """
    now = time.time()
    if _GATE["value"] is not None and now - _GATE["at"] < GATE_TTL:
        return _GATE["value"]
    doc = {}
    try:
        docs = fd._fs_list("cms_config")
        doc = next((d for d in docs if d.get("_id") == "auth"), {}) or {}
    except Exception:  # noqa: BLE001
        doc = {}
    value = {
        "userManagementEnabled": bool(doc.get("userManagementEnabled", False)),
        "adminLoginRequired": bool(doc.get("adminLoginRequired", True)),
    }
    _GATE.update({"at": now, "value": value})
    return value


def set_gate(enabled: bool) -> dict:
    fd.fs_write("cms_config", "auth", {"userManagementEnabled": bool(enabled)}, merge=True)
    _GATE.update({"at": 0.0, "value": None})
    return get_gate()


def resolve_account(email: str | None) -> dict:
    """The effective account, after the owner's access-control switch.

    With user management OFF (the MVP default) every visitor gets the full
    map for free; with it ON the plan model decides.
    """
    account = _resolve_profile(email)
    gate = get_gate()
    account["gateEnabled"] = gate["userManagementEnabled"]
    if not gate["userManagementEnabled"]:
        account["plan"] = "premium"
    return account


def _resolve_profile(email: str | None) -> dict:
    """The plan derived from the user / company records."""
    email = (email or "").strip().lower()
    if not email:
        return {"signedIn": False, "email": None, "plan": "free",
                "name": None, "role": "guest", "company": None,
                "subscriptionStatus": None, "isAdmin": False}

    if email in _admins():
        return {"signedIn": True, "email": email, "plan": "enterprise",
                "name": email.split("@")[0], "role": "admin", "company": None,
                "subscriptionStatus": "active", "isAdmin": True}

    for company in list_companies():
        employees = [str(e).lower() for e in (company.get("employees") or [])]
        if email in employees:
            sub = company.get("subscription") or {}
            status = sub.get("status") or "active"
            plan = _normalize_plan(sub.get("plan") or "Enterprise")
            if status == "expired":
                plan = "free"
            return {"signedIn": True, "email": email, "plan": plan,
                    "name": email.split("@")[0], "role": "user",
                    "company": {"id": company.get("_id"), "name": company.get("name")},
                    "subscriptionStatus": status, "isAdmin": False}

    user = find_user_by_email(email)
    if user:
        sub = user.get("subscription") or {}
        status = sub.get("status") or "active"
        plan = _normalize_plan(sub.get("plan") or "Basic")
        if status == "expired":
            plan = "free"
        return {"signedIn": True, "email": email, "plan": plan,
                "name": user.get("name") or email.split("@")[0],
                "role": user.get("role") or "user", "company": None,
                "subscriptionStatus": status, "isAdmin": False}

    # A Google account with no profile yet: no paid access.
    return {"signedIn": True, "email": email, "plan": "free",
            "name": email.split("@")[0], "role": "user", "company": None,
            "subscriptionStatus": None, "isAdmin": False}


def verify_id_token(authorization: str | None) -> dict | None:
    if not authorization or not authorization.lower().startswith("bearer "):
        return None
    token = authorization.split(" ", 1)[1].strip()
    try:
        from google.oauth2 import id_token

        return id_token.verify_firebase_token(
            token, fd._UrllibTransport(), audience=fd.PROJECT,
            clock_skew_in_seconds=120,
        )
    except Exception:  # noqa: BLE001
        return None
