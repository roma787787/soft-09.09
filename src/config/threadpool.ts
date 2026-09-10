/**
 * Widens libuv's threadpool before anything can use it.
 *
 * Hostname resolution does not happen on the event loop: `dns.lookup`, which
 * every outbound request goes through, is blocking work handed to libuv's
 * threadpool - and that pool holds four threads by default. A sweep across a
 * hundred and fifty chains resolves several hundred hostnames, so from the
 * fifth one onwards a request waits for a thread rather than for a
 * nameserver. The wait is charged to the request, which is how a healthy node
 * comes back as "no answer in six seconds" and its chain drops out of the
 * report - where a missing chain reads as "no liquidity here".
 *
 * The tell was the timings: the five slowest chains in one /diag were 5398,
 * 5387, 5329, 5289 and 5240 ms - five numbers inside a 160 ms band, pressed
 * against a 6000 ms ceiling. Nodes on four continents do not agree to that
 * precision. Queueing does.
 *
 * Imported for its side effect, and always first: libuv reads this variable
 * once, when the pool is first used, and the database module touches the
 * filesystem - which uses the same pool - at import time. An explicit value
 * in the environment wins, so a deployment can still tune it.
 */
const DEFAULT_THREADPOOL_SIZE = "32";

process.env.UV_THREADPOOL_SIZE ||= DEFAULT_THREADPOOL_SIZE;

/**
 * What was asked for. Not necessarily what libuv granted: it caps the pool
 * at 1024 and, more to the point, ignores the variable entirely if something
 * already used the pool before this ran. Logged at startup so that
 * possibility is visible rather than assumed.
 */
export const requestedThreadpoolSize = process.env.UV_THREADPOOL_SIZE;
