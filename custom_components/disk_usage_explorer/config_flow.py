"""Configuration flow for Disk Usage Explorer."""

from __future__ import annotations

from pathlib import Path

import voluptuous as vol
from homeassistant import config_entries
from homeassistant.data_entry_flow import FlowResult
from homeassistant.helpers import selector

from .const import DOMAIN

CONF_ALLOWED_ROOTS = "allowed_roots"
DEFAULT_ALLOWED_ROOTS = "/media"


class DiskUsageExplorerConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Configure the roots the integration is allowed to scan."""

    VERSION = 1

    async def async_step_user(self, user_input: dict | None = None) -> FlowResult:
        """Set allowed root directories."""
        errors: dict[str, str] = {}

        if user_input is not None:
            roots = [line.strip() for line in user_input[CONF_ALLOWED_ROOTS].splitlines() if line.strip()]
            try:
                normalized = await self.hass.async_add_executor_job(_validate_roots, roots)
            except ValueError:
                errors[CONF_ALLOWED_ROOTS] = "invalid_roots"
            else:
                return self.async_create_entry(
                    title="Disk Usage Explorer",
                    data={CONF_ALLOWED_ROOTS: normalized},
                )

        return self.async_show_form(
            step_id="user",
            data_schema=vol.Schema(
                {
                    vol.Required(CONF_ALLOWED_ROOTS, default=DEFAULT_ALLOWED_ROOTS): selector.TextSelector(
                        selector.TextSelectorConfig(multiline=True)
                    )
                }
            ),
            errors=errors,
        )


def _validate_roots(roots: list[str]) -> list[str]:
    """Resolve and validate the configured scan roots."""
    normalized: list[str] = []
    for root in roots:
        path = Path(root)
        if not path.is_absolute() or not path.is_dir():
            raise ValueError("Roots must be existing absolute directories")
        resolved = str(path.resolve(strict=True))
        if resolved not in normalized:
            normalized.append(resolved)
    if not normalized:
        raise ValueError("At least one root is required")
    return normalized
