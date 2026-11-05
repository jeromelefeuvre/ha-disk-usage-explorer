"""Disk Usage Explorer integration."""

from __future__ import annotations

from pathlib import Path

import voluptuous as vol
from homeassistant.components import frontend
from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, ServiceCall, ServiceResponse, SupportsResponse
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.service import async_register_admin_service

from .const import (
    CARD_URL,
    DOMAIN,
    PLATFORMS,
    SERVICE_BROWSE,
    SERVICE_CANCEL,
    SERVICE_SCAN,
    SERVICE_SUGGEST,
    STATIC_URL,
)
from .config_flow import CONF_ALLOWED_ROOTS
from .scanner import DiskScanner

# Configured from the UI only; this also tells hassfest async_setup takes no YAML.
CONFIG_SCHEMA = cv.config_entry_only_config_schema(DOMAIN)


def _get_scanner(hass: HomeAssistant) -> DiskScanner:
    scanner = hass.data.get(DOMAIN, {}).get("scanner")
    if scanner is None:
        raise HomeAssistantError(translation_domain=DOMAIN, translation_key="not_configured")
    return scanner


async def async_setup(hass: HomeAssistant, config: dict) -> bool:
    """Register services and serve the bundled Lovelace card."""
    card_path = Path(__file__).parent / "disk-usage-explorer.js"
    await hass.http.async_register_static_paths(
        [StaticPathConfig(f"{STATIC_URL}/disk-usage-explorer.js", str(card_path), False)]
    )
    # Version the URL with the file's mtime so browsers reload the card after an update.
    mtime = await hass.async_add_executor_job(lambda: int(card_path.stat().st_mtime))
    frontend.add_extra_js_url(hass, f"{CARD_URL}?v={mtime}")

    async def scan(call: ServiceCall) -> None:
        """Start a read-only scan."""
        await _get_scanner(hass).async_start_scan(call.data["path"])

    async def cancel(call: ServiceCall) -> None:
        """Stop the running scan, if any."""
        _get_scanner(hass).cancel()

    async def browse(call: ServiceCall) -> ServiceResponse:
        """Return the requested directory from the completed scan."""
        return _get_scanner(hass).browse(call.data.get("path", ""))

    async def suggest_directories(call: ServiceCall) -> ServiceResponse:
        """Suggest existing child directories below configured roots."""
        return await _get_scanner(hass).async_suggest_directories(call.data.get("path", ""))

    # Admin only: these actions reveal the folder tree below the allowed folders.
    async_register_admin_service(
        hass,
        DOMAIN,
        SERVICE_SCAN,
        scan,
        schema=vol.Schema({vol.Required("path"): cv.string}),
    )
    async_register_admin_service(hass, DOMAIN, SERVICE_CANCEL, cancel, schema=vol.Schema({}))
    async_register_admin_service(
        hass,
        DOMAIN,
        SERVICE_BROWSE,
        browse,
        schema=vol.Schema({vol.Optional("path", default=""): cv.string}),
        supports_response=SupportsResponse.ONLY,
    )
    async_register_admin_service(
        hass,
        DOMAIN,
        SERVICE_SUGGEST,
        suggest_directories,
        schema=vol.Schema({vol.Optional("path", default=""): cv.string}),
        supports_response=SupportsResponse.ONLY,
    )
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up a scanner and status entity for one config entry."""
    scanner = DiskScanner(hass, entry.data[CONF_ALLOWED_ROOTS])
    await scanner.async_load()
    hass.data.setdefault(DOMAIN, {})["scanner"] = scanner
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload the integration entry."""
    unloaded = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unloaded:
        scanner = hass.data.get(DOMAIN, {}).pop("scanner", None)
        if scanner:
            await scanner.async_stop()
    return unloaded
