_ORDER_FIELDS = [
    {"key": "category", "type": "select", "required": True, "options": ["LAB", "RAD", "PROC", "NURSING", "DIET", "PHARM"]},
    {"key": "service_id", "label": "Test / service", "type": "service", "required": True},
    {"key": "priority", "type": "select", "default": "Routine", "options": ["Routine", "Urgent", "STAT"]},
    {"key": "clinical_notes", "label": "Clinical indication"},
    {"key": "ordering_doctor", "type": "doctor", "default": "me"},
    {"key": "ordered_at", "type": "datetime", "readonly": True},
    {"key": "collected_at", "type": "datetime", "readonly": True},
    {"key": "resulted_at", "type": "datetime", "readonly": True},
    {"key": "verified_at", "type": "datetime", "readonly": True},
    {"key": "sample_barcode", "readonly": True},
    {"key": "result", "label": "Result / report", "type": "textarea", "rows": 6},
    {"key": "result_values", "label": "Result values", "type": "lines", "fields": [
        {"key": "parameter", "required": True},
        {"key": "value"},
        {"key": "unit"},
        {"key": "ref_range", "label": "Reference range"},
        {"key": "flag", "type": "select", "options": ["Normal", "Low", "High", "Critical Low", "Critical High", "Abnormal"]},
    ]},
    {"key": "impression"},
    {"key": "critical", "label": "Critical result", "type": "boolean", "readonly": True},
    {"key": "verified_by", "readonly": True},
    {"key": "tat_minutes", "label": "TAT (ordered → verified)", "type": "number", "unit": "min", "readonly": True},
    {"key": "acknowledged_at", "type": "datetime", "readonly": True},
    {"key": "acknowledged_by", "readonly": True},
    {"key": "cancel_reason", "hidden": True},
]

_TRANSITIONS = [
    {"from": ["Ordered"], "to": "Collected", "label": "Collect sample", "stamp": "collected_at", "roles": ["lab", "nurse"]},
    {"from": ["Ordered", "Collected"], "to": "In Progress", "label": "Start processing", "roles": ["lab", "radiology", "nurse", "doctor"]},
    {"from": ["In Progress"], "to": "Resulted", "label": "Enter result", "stamp": "resulted_at",
     "roles": ["lab", "radiology", "doctor", "nurse"], "fields": ["result_values", "result", "impression"]},
    {"from": ["Resulted"], "to": "Verified", "label": "Verify & authorise", "stamp": "verified_at",
     "roles": ["lab", "radiology", "doctor"], "tone": "success"},
    {"from": ["Ordered", "Collected"], "to": "Cancelled", "label": "Cancel order", "tone": "danger",
     "fields": ["cancel_reason"], "require": ["cancel_reason"]},
]

_STATUSES = ["Ordered", "Collected", "In Progress", "Resulted", "Verified", "Cancelled"]
_LIST = ["code", "patient_id", "service_id", "priority", "ordered_at", "critical", "status"]

MODULE = {
    "no": 23,
    "id": "orders",
    "suite": "clinical",
    "name": "Orders & Results",
    "icon": "ClipboardList",
    "summary": "Computerised order entry for lab, radiology, pharmacy and procedures with a result inbox and critical result acknowledgement.",
    "features": [
        "Computerised order entry for lab, radiology, pharmacy and procedures",
        "Result inbox",
        "Critical result acknowledgement",
    ],
    "roles": ["doctor", "nurse"],
    "read_roles": ["lab", "radiology", "billing", "pharmacist", "quality"],
    "pages": [{"key": "cpoe", "label": "Order Entry", "icon": "ListPlus"},
              {"key": "result-inbox", "label": "Result Inbox", "icon": "Inbox"}],
    "entities": [
        {
            "key": "orders",
            "label": "Orders",
            "table": "orders",
            "prefix": "ORD",
            "patient": True,
            "encounter": "optional",
            "date_field": "ordered_at",
            "sort": "-ordered_at",
            "statuses": _STATUSES,
            "transitions": _TRANSITIONS,
            "charge": {"on": "create", "service_field": "service_id"},
            "fields": _ORDER_FIELDS,
            "list": ["code", "patient_id", "category", "service_id", "priority", "ordered_at", "critical", "status"],
        },
    ],
    "kpis": [
        {"label": "Orders today", "entity": "orders", "period": "today"},
        {"label": "Pending results", "entity": "orders", "where": {"status": ["Ordered", "Collected", "In Progress"]}},
        {"label": "Awaiting verification", "entity": "orders", "where": {"status": "Resulted"}},
        {"label": "Unacknowledged critical", "entity": "orders", "where": {"critical": True, "status": ["Resulted", "Verified"]}},
    ],
}

# Re-used by the Laboratory and Radiology modules (same `orders` table, scoped by category).
ORDER_FIELDS = _ORDER_FIELDS
ORDER_TRANSITIONS = _TRANSITIONS
ORDER_STATUSES = _STATUSES
ORDER_LIST = _LIST
