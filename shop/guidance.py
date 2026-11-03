"""Predictable guidance for requests the shop assistant cannot fulfil."""

from typing import Literal


SUGGESTED_QUESTIONS = [
    "What was our October revenue and profit?",
    "Which products should we restock?",
    "Which invoices are overdue?",
]


def redirect_to_shop(reason: Literal["outside_scope", "unsupported_action", "capabilities"]) -> dict:
    """Guide users back to supported shop questions without reading any records.

    Use outside_scope for unrelated topics (weather, news, recipes, coding, etc.),
    unsupported_action for requests to pay, send, edit or change records, and
    capabilities when asked what this assistant can help with. For a mixed request,
    also call the relevant business tools to answer the supported part. Missing
    monthly data is not outside_scope: call a business tool for the requested month.
    """
    introductions = {
        "outside_scope": "I can help with the shop’s records, but I can’t look up weather or answer unrelated questions here.",
        "unsupported_action": "I can look up the shop’s records, but I can’t make payments, send invoices, or change the data.",
        "capabilities": "I can help you check the shop’s sales, profit, stock, and unpaid invoices.",
    }
    return {
        "reason": reason,
        "reply": introductions[reason] + " Try one of these questions about our sample shop.",
        "suggested_questions": list(SUGGESTED_QUESTIONS),
    }
