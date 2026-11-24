/* headless_pointer — ONE persistent virtual pointer for a headless instance.
 *
 * Why (measured 2026-09-03 on the nested headless sway): the seat of a headless
 * instance has no input devices (get_seats: capabilities 0). `wlrctl pointer …`
 * creates a virtual pointer, acts, and exits; the device disappears with it, the
 * seat loses its pointer capability, the surface's pointer focus is cleared, and
 * the NEXT one-shot `wlrctl pointer click` presses a button with no focused
 * surface — the page never sees a pointer event (a document-level capture
 * listener counted zero). Keys worked only because wtype delivers them inside
 * its own process lifetime. Holding one virtual pointer for the instance's whole
 * life keeps the capability and the focus, so motion/button/axis reach the page.
 *
 * Protocol: wlr-virtual-pointer-unstable-v1 (the same one wlrctl uses); the
 * interface tables are generated from the protocol XML by wayland-scanner at
 * build time (see headless_pointer_build.mjs). Commands on stdin, one per line,
 * answered with "ok"/"err …" on stdout:
 *   move X Y          absolute position on the seat's (single) output, pixels
 *   button NAME ACT   NAME = left|right|middle, ACT = press|release|click
 *   scroll DY         vertical wheel steps (positive = down), via axis events
 *   quit
 * The process exits when stdin closes, destroying the pointer with it. */
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/time.h>
#include <wayland-client.h>
#include <linux/input-event-codes.h>
#include "wlr-virtual-pointer-unstable-v1-client-protocol.h"

static struct wl_seat *seat = NULL;
static struct wl_output *output = NULL;
static struct zwlr_virtual_pointer_manager_v1 *manager = NULL;
static int32_t out_w = 0, out_h = 0;

static uint32_t now_ms(void) {
  struct timeval tv; gettimeofday(&tv, NULL);
  return (uint32_t)(tv.tv_sec * 1000 + tv.tv_usec / 1000);
}

static void output_geometry(void *d, struct wl_output *o, int32_t x, int32_t y, int32_t pw, int32_t ph, int32_t sub, const char *make, const char *model, int32_t transform) {
  (void)d; (void)o; (void)x; (void)y; (void)pw; (void)ph; (void)sub; (void)make; (void)model; (void)transform;
}
static void output_mode(void *d, struct wl_output *o, uint32_t flags, int32_t w, int32_t h, int32_t refresh) {
  (void)d; (void)o; (void)refresh;
  if (flags & WL_OUTPUT_MODE_CURRENT) {
    /* The mode is in physical pixels; the caller's coordinates are layout (logical) units. A zoomed-out demo output
     * (COMPUTER_USE_VISIBLE_SCALE, e.g. 0.5) has twice as many layout units: map over those, or every click lands at
     * twice its position (live DFYNE 2026-09-26: the "United States" list item was never hit). */
    const char *sv = getenv("COMPUTER_USE_VISIBLE_SCALE");
    double scale = sv ? atof(sv) : 0.0;
    if (scale > 0.0 && scale != 1.0) { out_w = (int32_t)(w / scale + 0.5); out_h = (int32_t)(h / scale + 0.5); }
    else { out_w = w; out_h = h; }
  }
}
static void output_done(void *d, struct wl_output *o) { (void)d; (void)o; }
static void output_scale(void *d, struct wl_output *o, int32_t f) { (void)d; (void)o; (void)f; }
static void output_name(void *d, struct wl_output *o, const char *n) { (void)d; (void)o; (void)n; }
static void output_description(void *d, struct wl_output *o, const char *n) { (void)d; (void)o; (void)n; }
static const struct wl_output_listener output_listener = { output_geometry, output_mode, output_done, output_scale, output_name, output_description };

static void registry_global(void *d, struct wl_registry *r, uint32_t name, const char *iface, uint32_t version) {
  (void)d;
  if (!seat && strcmp(iface, wl_seat_interface.name) == 0) seat = wl_registry_bind(r, name, &wl_seat_interface, version < 5 ? version : 5);
  else if (!output && strcmp(iface, wl_output_interface.name) == 0) { output = wl_registry_bind(r, name, &wl_output_interface, version < 4 ? version : 4); wl_output_add_listener(output, &output_listener, NULL); }
  else if (!manager && strcmp(iface, zwlr_virtual_pointer_manager_v1_interface.name) == 0) manager = wl_registry_bind(r, name, &zwlr_virtual_pointer_manager_v1_interface, version < 2 ? version : 2);
}
static void registry_remove(void *d, struct wl_registry *r, uint32_t name) { (void)d; (void)r; (void)name; }
static const struct wl_registry_listener registry_listener = { registry_global, registry_remove };

static uint32_t button_code(const char *name) {
  if (strcmp(name, "left") == 0) return BTN_LEFT;
  if (strcmp(name, "right") == 0) return BTN_RIGHT;
  if (strcmp(name, "middle") == 0) return BTN_MIDDLE;
  return 0;
}

int main(void) {
  setvbuf(stdout, NULL, _IOLBF, 0); /* one answer line per command, flushed as it is written */
  struct wl_display *display = wl_display_connect(NULL);
  if (!display) { fprintf(stderr, "headless_pointer: no wayland display\n"); return 2; }
  struct wl_registry *registry = wl_display_get_registry(display);
  wl_registry_add_listener(registry, &registry_listener, NULL);
  wl_display_roundtrip(display);
  wl_display_roundtrip(display); /* output modes arrive after the bind */
  if (!seat || !manager) { fprintf(stderr, "headless_pointer: seat or zwlr_virtual_pointer_manager_v1 missing\n"); return 3; }
  struct zwlr_virtual_pointer_v1 *pointer = output && zwlr_virtual_pointer_manager_v1_get_version(manager) >= 2
    ? zwlr_virtual_pointer_manager_v1_create_virtual_pointer_with_output(manager, seat, output)
    : zwlr_virtual_pointer_manager_v1_create_virtual_pointer(manager, seat);
  wl_display_roundtrip(display);
  if (out_w <= 0 || out_h <= 0) { out_w = 1920; out_h = 1080; }
  int32_t cur_x = 0, cur_y = 0; /* the last commanded position, re-asserted before a combined click */
  /* Park the cursor at the origin so the first move is absolute from a known place. */
  zwlr_virtual_pointer_v1_motion_absolute(pointer, now_ms(), 0, 0, (uint32_t)out_w, (uint32_t)out_h);
  zwlr_virtual_pointer_v1_frame(pointer);
  wl_display_flush(display);
  printf("ready %d %d\n", out_w, out_h); fflush(stdout);

  char line[256];
  while (fgets(line, sizeof line, stdin)) {
    char cmd[16] = {0}, a[16] = {0}, b[16] = {0};
    int n = sscanf(line, "%15s %15s %15s", cmd, a, b);
    if (n < 1) continue;
    if (strcmp(cmd, "quit") == 0) break;
    if (strcmp(cmd, "move") == 0 && n == 3) {
      long x = strtol(a, NULL, 10), y = strtol(b, NULL, 10);
      if (x < 0) { x = 0; }
      if (y < 0) { y = 0; }
      if (x >= out_w) { x = out_w - 1; }
      if (y >= out_h) { y = out_h - 1; }
      cur_x = (int32_t)x; cur_y = (int32_t)y;
      zwlr_virtual_pointer_v1_motion_absolute(pointer, now_ms(), (uint32_t)x, (uint32_t)y, (uint32_t)out_w, (uint32_t)out_h);
      zwlr_virtual_pointer_v1_frame(pointer);
    } else if (strcmp(cmd, "button") == 0 && n == 3) {
      uint32_t code = button_code(a);
      if (!code) { printf("err button\n"); continue; }
      int is_press = strcmp(b, "press") == 0, is_release = strcmp(b, "release") == 0, is_click = strcmp(b, "click") == 0;
      if (!is_press && !is_release && !is_click) { printf("err action\n"); continue; }
      /* A combined click carries no preceding move of its own; re-assert a fresh motion frame at
         the last target immediately before the press, so a store's mousedown wrapper that ignores
         a press after an idle pointer still sees this one. (The decomposed path sends its own move.) */
      if (is_click) { zwlr_virtual_pointer_v1_motion_absolute(pointer, now_ms(), (uint32_t)cur_x, (uint32_t)cur_y, (uint32_t)out_w, (uint32_t)out_h); zwlr_virtual_pointer_v1_frame(pointer); }
      if (is_press || is_click) { zwlr_virtual_pointer_v1_button(pointer, now_ms(), code, WL_POINTER_BUTTON_STATE_PRESSED); zwlr_virtual_pointer_v1_frame(pointer); }
      /* Hold the button down until the compositor has processed the press — one display round trip,
         a measured ordering rather than a sleep constant — before the release completes the click. */
      if (is_click) { if (wl_display_flush(display) < 0 || wl_display_roundtrip(display) < 0) { printf("err display\n"); break; } }
      if (is_release || is_click) { zwlr_virtual_pointer_v1_button(pointer, now_ms(), code, WL_POINTER_BUTTON_STATE_RELEASED); zwlr_virtual_pointer_v1_frame(pointer); }
    } else if (strcmp(cmd, "scroll") == 0 && n == 2) {
      long dy = strtol(a, NULL, 10);
      if (dy == 0) { printf("err scroll\n"); continue; }
      zwlr_virtual_pointer_v1_axis_source(pointer, WL_POINTER_AXIS_SOURCE_WHEEL);
      zwlr_virtual_pointer_v1_axis_discrete(pointer, now_ms(), WL_POINTER_AXIS_VERTICAL_SCROLL, wl_fixed_from_int((int)dy * 15), (int32_t)dy);
      zwlr_virtual_pointer_v1_frame(pointer);
    } else { printf("err syntax\n"); continue; }
    if (wl_display_flush(display) < 0 || wl_display_roundtrip(display) < 0) { printf("err display\n"); break; }
    printf("ok\n");
  }
  zwlr_virtual_pointer_v1_destroy(pointer);
  wl_display_disconnect(display);
  return 0;
}
