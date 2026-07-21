// Tests use ephemeral loopback Instance servers. The production Host requires
// HTTPS/public addressing unless this explicit switch is present.
process.env["ALLOW_LOOPBACK_INSTANCE_ORIGINS"] = "true";
