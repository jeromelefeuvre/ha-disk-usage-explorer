"""Constants for the disk usage explorer integration."""

from homeassistant.const import Platform

DOMAIN = "disk_usage_explorer"
PLATFORMS = [Platform.SENSOR]
SIGNAL_UPDATE = f"{DOMAIN}_update"
SERVICE_SCAN = "scan"
SERVICE_BROWSE = "browse"
SERVICE_CANCEL = "cancel"
SERVICE_SUGGEST = "suggest_directories"
STATUS_ENTITY_ID = "sensor.disk_usage_explorer_status"
STATUSES = ["idle", "scanning", "completed", "cancelled", "error"]
STATIC_URL = "/disk-usage-explorer"
CARD_URL = f"{STATIC_URL}/disk-usage-explorer.js"
