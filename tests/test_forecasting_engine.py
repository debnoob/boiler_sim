"""Unit tests for the Moirai forecast adapter and its safe fallback."""

from collections import deque
import json

import numpy as np
import pytest


torch = pytest.importorskip("torch")
pytest.importorskip("paho.mqtt.client")

import forecasting_engine


class _Distribution:
    def __init__(self, samples):
        self.samples = samples
        self.requested_shape = None

    def sample(self, shape):
        self.requested_shape = shape
        return self.samples


class _MoiraiModel:
    def __init__(self, samples):
        self.samples = samples
        self.calls = []
        self._parameter = torch.nn.Parameter(torch.zeros(1))

    def parameters(self):
        return iter((self._parameter,))

    def __call__(self, **kwargs):
        self.calls.append(kwargs)
        return _Distribution(self.samples)


class _TensorMoiraiModel(_MoiraiModel):
    """Matches Moirai2Forecast, which returns [batch, samples, horizon]."""

    def __call__(self, **kwargs):
        self.calls.append(kwargs)
        return self.samples


class _Moirai2QuantileModel(_MoiraiModel):
    def __init__(self, quantiles):
        super().__init__(quantiles)
        self.hparams = type("Hparams", (), {"context_length": 90})()
        self.module = type("Module", (), {
            "quantile_levels": [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]
        })()

    def __call__(self, **kwargs):
        self.calls.append(kwargs)
        return self.samples


def test_uni2ts_inference_supplies_padding_mask_and_returns_ordered_bands():
    paths = torch.stack(
        [torch.full((1, forecasting_engine.FORECAST_HORIZON, 1), float(i)) for i in range(100)]
    )
    model = _MoiraiModel(paths)

    result = forecasting_engine.run_inference_uni2ts(
        model, np.linspace(80.0, 90.0, 30)
    )

    call = model.calls[0]
    assert call["past_target"].shape == (1, 30, 1)
    assert call["past_observed_target"].shape == (1, 30, 1)
    assert call["past_is_pad"].shape == (1, 30)
    assert not call["past_is_pad"].any()
    assert [len(result[key]) for key in ("p10", "p50", "p90")] == [60, 60, 60]
    assert result["p10"][0] <= result["p50"][0] <= result["p90"][0]


def test_uni2ts_accepts_direct_tensor_paths_from_moirai2_forecast():
    paths = torch.stack(
        [torch.full((forecasting_engine.FORECAST_HORIZON,), float(i)) for i in range(100)]
    ).unsqueeze(0)
    model = _TensorMoiraiModel(paths)

    result = forecasting_engine.run_inference_uni2ts(
        model, np.linspace(80.0, 90.0, 30)
    )

    assert [len(result[key]) for key in ("p10", "p50", "p90")] == [60, 60, 60]
    assert result["p10"][0] == pytest.approx(9.9)
    assert result["p50"][0] == pytest.approx(49.5)
    assert result["p90"][0] == pytest.approx(89.1)


def test_moirai2_pads_warmup_context_and_uses_native_quantiles():
    quantiles = torch.stack(
        [torch.full((forecasting_engine.FORECAST_HORIZON, 1), float(i)) for i in range(1, 10)]
    ).unsqueeze(0)
    model = _Moirai2QuantileModel(quantiles)

    result = forecasting_engine.run_inference_uni2ts(
        model, np.linspace(80.0, 90.0, 30)
    )

    call = model.calls[0]
    assert call["past_target"].shape == (1, 90, 1)
    assert call["past_is_pad"][:, :60].all()
    assert not call["past_observed_target"][:, :60, :].any()
    assert result["p10"][0] == 1.0
    assert result["p50"][0] == 5.0
    assert result["p90"][0] == 9.0


def test_failed_moirai_inference_reports_simulation_as_effective_backend():
    class BrokenModel:
        def parameters(self):
            return iter(())

        def __call__(self, **kwargs):
            raise RuntimeError("model unavailable")

    class MqttClient:
        payload = None

        def publish(self, topic, payload, qos):
            self.payload = payload

    forecaster = forecasting_engine.MoiraiForecaster.__new__(forecasting_engine.MoiraiForecaster)
    forecaster.backend = "uni2ts"
    forecaster.model = BrokenModel()
    forecaster.mqtt_client = MqttClient()
    forecaster.histories = {
        metric: deque(np.linspace(90.0, 80.0, 30), maxlen=forecasting_engine.HISTORY_LEN)
        for metric in forecasting_engine.METRICS
    }

    forecaster.run_and_publish()

    published = json.loads(forecaster.mqtt_client.payload)
    assert published["backend"] == "simulation"
    assert published["configured_backend"] == "uni2ts"
