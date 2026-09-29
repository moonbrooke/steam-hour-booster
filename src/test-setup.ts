/**
 * Test bootstrap.
 *
 * Raises the log threshold so expected server startup messages do not drown the
 * test reporter's output. Individual tests can still assert on their own loggers.
 */
process.env["LOG_LEVEL"] ??= "warn";
