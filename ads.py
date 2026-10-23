"""
ads.py — Ad campaigns (Firestore `ads` + media in Storage).

Model (same as new kwizi):
  { title, mediaUrl, mediaType: image|video, targetUrl, beneficiaryName,
    placement: corner|top|bottom|right, status: active|inactive, createdAt }
"""

import time
import urllib.parse
import urllib.request
import uuid

from fastapi import HTTPException

import firebase_data as fd
from admin import _set_download_token, _storage_bucket, _upload_object

PLACEMENTS = {
    "corner": "Left of the map (side column)",
    "top": "Above the map (thin banner)",
    "bottom": "Below the map (thin banner)",
    "right": "Right of the map (side column)",
}
RECOMMENDED = {
    "corner": (160, 600),
    "top": (1024, 80),
    "bottom": (1024, 80),
    "right": (160, 600),
}


def list_ads(active_only: bool = False) -> list[dict]:
    try:
        ads = fd._fs_list("ads")
    except Exception:  # noqa: BLE001
        return []
    if active_only:
        ads = [a for a in ads if (a.get("status") or "active") == "active"]
    ads.sort(key=lambda a: -(float(a.get("createdAt") or 0)))
    return ads


def create_ad(title: str, target_url: str, placement: str, content: bytes,
              filename: str, content_type: str, beneficiary: str = "") -> dict:
    if not title.strip():
        raise HTTPException(status_code=400, detail="The campaign needs a title")
    if placement not in PLACEMENTS:
        raise HTTPException(status_code=400, detail="Unknown placement")
    if not content:
        raise HTTPException(status_code=400, detail="The campaign needs an image or video")

    ext = (filename.rsplit(".", 1)[-1] if "." in filename else "bin").lower()[:8]
    media_type = "video" if content_type.startswith("video/") else "image"
    object_path = f"ads/{int(time.time())}-{uuid.uuid4().hex[:8]}.{ext}"
    _upload_object(object_path, content, content_type or "application/octet-stream")
    media_url = _set_download_token(object_path)

    record = {
        "title": title.strip(),
        "mediaUrl": media_url,
        "mediaPath": object_path,
        "mediaType": media_type,
        "targetUrl": target_url.strip(),
        "beneficiaryName": beneficiary.strip(),
        "placement": placement,
        "status": "active",
        "createdAt": int(time.time() * 1000),
    }
    doc_id = fd.fs_write("ads", f"ad-{int(time.time())}-{uuid.uuid4().hex[:6]}", record)
    return {"id": doc_id, **record}


def set_status(ad_id: str, status: str) -> None:
    if status not in ("active", "inactive"):
        raise HTTPException(status_code=400, detail="status must be active or inactive")
    fd.fs_write("ads", ad_id, {"status": status}, merge=True)


def set_placement(ad_id: str, placement: str) -> None:
    if placement not in PLACEMENTS:
        raise HTTPException(status_code=400, detail="Unknown placement")
    fd.fs_write("ads", ad_id, {"placement": placement}, merge=True)


def delete_ad(ad_id: str) -> None:
    ad = next((a for a in list_ads() if a.get("_id") == ad_id), None)
    fd.fs_delete("ads", ad_id)
    path = (ad or {}).get("mediaPath")
    if path:
        bucket = _storage_bucket()
        url = (
            "https://storage.googleapis.com/storage/v1/b/"
            + urllib.parse.quote(bucket, safe="")
            + "/o/"
            + urllib.parse.quote(path, safe="")
        )
        try:
            req = urllib.request.Request(
                url, headers={"Authorization": f"Bearer {fd.token()}"}, method="DELETE"
            )
            with urllib.request.urlopen(req, timeout=60) as r:
                r.read()
        except Exception:  # noqa: BLE001
            pass
