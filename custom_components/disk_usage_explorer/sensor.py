"""Status sensor for Disk Usage Explorer."""

from __future__ import annotations

from homeassistant.components.sensor import SensorDeviceClass, SensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN, SIGNAL_UPDATE, STATUSES
from .scanner import DiskScanner


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Add the scan status sensor."""
    scanner: DiskScanner = hass.data[DOMAIN]["scanner"]
    async_add_entities([DiskUsageStatusSensor(scanner)])


class DiskUsageStatusSensor(SensorEntity):
    """Expose scan status and compact progress attributes."""

    _attr_has_entity_name = False
    _attr_name = "Disk Usage Explorer Status"
    _attr_icon = "mdi:harddisk"
    # Enum states are translated in the Home Assistant UI (see translations/*.json).
    _attr_device_class = SensorDeviceClass.ENUM
    _attr_options = STATUSES
    _attr_translation_key = "status"
    # Progress/volatile details are not useful in history and would bloat the recorder.
    _unrecorded_attributes = frozenset(
        {
            "scan_id",
            "items_scanned",
            "started_at",
            "finished_at",
            "warning_count",
            "symlinks_skipped",
            "hardlinks_deduplicated",
            "max_items",
        }
    )

    def __init__(self, scanner: DiskScanner) -> None:
        self.scanner = scanner
        self._attr_unique_id = "disk_usage_explorer_status"

    @property
    def native_value(self) -> str:
        """Return the current scanner state."""
        return self.scanner.status

    @property
    def extra_state_attributes(self) -> dict:
        """Return compact scan details."""
        return self.scanner.attributes

    async def async_added_to_hass(self) -> None:
        """Subscribe to scanner updates."""
        await super().async_added_to_hass()
        self.async_on_remove(
            async_dispatcher_connect(self.hass, SIGNAL_UPDATE, self.async_write_ha_state)
        )
