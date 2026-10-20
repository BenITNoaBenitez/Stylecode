(function (root) {
  "use strict";
  function calUrl(slug, config) {
    if (!config || config.enabled !== true || typeof config.username !== "string" || typeof slug !== "string") return null;
    if (!/^[a-zA-Z0-9_-]+$/.test(config.username) || !/^[a-zA-Z0-9_-]+$/.test(slug)) return null;
    return "https://cal.com/" + config.username + "/" + slug;
  }
  function bookingUrl(id, config) {
    return calUrl(config && config.events && config.events[id], config);
  }
  function businessUrl(config) {
    return calUrl(config && config.businessEvent, config);
  }
  function paymentUrl(id, config, location) {
    if (!config || !["test", "live"].includes(config.mode)) return null;
    const local = location && (location.protocol === "file:" || ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname));
    if (config.mode === "test" && !local) return null;
    const raw = config.links && config.links[id];
    if (typeof raw !== "string" || !raw.trim()) return null;
    try {
      const url = new URL(raw);
      if (url.protocol !== "https:" || !["buy.stripe.com", "book.stripe.com"].includes(url.hostname) || url.username || url.password || url.port || url.hash) return null;
      if (!/^\/(?:test_)?[a-zA-Z0-9]+$/.test(url.pathname)) return null;
      const test = url.pathname.startsWith("/test_");
      if (test !== (config.mode === "test")) return null;
      url.searchParams.set("locale", "fr");
      url.searchParams.set("client_reference_id", "stylecode_" + id);
      return url.href;
    } catch (_) { return null; }
  }
  function offer(id, fallback, payLabel, reserveLabel) {
    const booking = bookingUrl(id, root.STYLECODE_BOOKING_CONFIG);
    // Cal.com handles booking and any payment enabled on the selected event.
    // Do not send the same service through a separate Stripe checkout first.
    if (booking) return { href: booking, label: reserveLabel, ready: true };
    const href = paymentUrl(id, root.STYLECODE_PAYMENT_CONFIG, root.location);
    return { href: href || fallback, label: href ? payLabel : reserveLabel, ready: Boolean(href) };
  }
  root.StylecodeCheckout = { paymentUrl: paymentUrl, bookingUrl: bookingUrl, businessUrl: businessUrl, offer: offer };
  if (typeof module !== "undefined" && module.exports) module.exports = root.StylecodeCheckout;
})(typeof window !== "undefined" ? window : globalThis);
