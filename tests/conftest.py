"""Fixtures for the operator-language golden tests."""

import os

import pytest


@pytest.fixture
def live_chat():
    """Send a question through the real chat prompt and return the answer text.

    Requires a reachable model. Guarded by NEXUS_LIVE_LLM=1 so that `-m llm` on a
    machine with no model skips loudly instead of failing with a connection error.
    """
    if os.environ.get("NEXUS_LIVE_LLM") != "1":
        pytest.skip("set NEXUS_LIVE_LLM=1 to run live-model tests")

    import ai_analyst

    def ask(question):
        answer = ai_analyst.call_llm(
            [
                {"role": "system", "content": ai_analyst.CHAT_SYSTEM_PROMPT},
                {"role": "user", "content": question},
            ],
            json_mode=False,
        )
        if not answer:
            pytest.fail(f"no answer from the model for: {question}")
        return answer

    return ask
