/* headless_keyboard — ONE persistent virtual keyboard for a headless instance.
 *
 * Why (measured 2026-09-03 on Target through the store browser): wtype types by
 * creating a NEW zwp_virtual_keyboard each call — upload a keymap, press a key,
 * destroy the device. A React-controlled search box keeps only the LAST device's
 * keystroke, so 13 single-character type_text calls leave one letter. This is the
 * keyboard twin of the pointer bug (a one-shot device that vanishes). Holding ONE
 * virtual keyboard for the instance's whole life — swapping only its keymap as new
 * characters appear, never the device — makes every keystroke land on the same
 * seat keyboard the page is already bound to.
 *
 * Protocol: virtual-keyboard-unstable-v1 (the same wtype uses); the interface
 * tables are generated from the vendored XML by wayland-scanner at build time.
 * Commands on stdin, one per line, answered with "ok"/"err ..." on stdout:
 *   text B64        type UTF-8 text (base64 so spaces/punctuation/UTF-8 ride one line)
 *   key NAME [MODS]  a named key (Return, Tab, BackSpace, Left, space, ...) with
 *                    optional +-joined modifiers (ctrl, shift, alt, logo)
 *   quit
 * Keys land on their REAL US-layout keycodes (x on KEY_X, capitals as Shift+letter,
 * Return on KEY_ENTER): Chromium derives KeyboardEvent.code from the evdev keycode, and
 * the old growing table put the first character typed on evdev 1 — KEY_ESC — so pages
 * saw key "x" with code "Escape" (live Target 2026-09-26: its sign-in sheet closed on
 * the first keystroke of the password). Characters outside the US layout (é, ñ, …)
 * still get keycodes of their own, from a high range with no meaning to pages. The
 * keymap is re-uploaded only when such a new character appears. The process exits
 * when stdin closes, destroying the keyboard with it. */
#define _GNU_SOURCE
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/mman.h>
#include <sys/time.h>
#include <wayland-client.h>
#include <xkbcommon/xkbcommon.h>
#include "virtual-keyboard-unstable-v1-client-protocol.h"

static struct wl_seat *seat = NULL;
static struct zwp_virtual_keyboard_manager_v1 *manager = NULL;
static struct zwp_virtual_keyboard_v1 *keyboard = NULL;

/* The US layout: evdev keycode, unshifted keysym, shifted keysym (NoSymbol = none). */
struct uskey { uint32_t code; xkb_keysym_t base, shifted; };
static const struct uskey US[] = {
  {1, XKB_KEY_Escape, 0},
  {2, XKB_KEY_1, XKB_KEY_exclam}, {3, XKB_KEY_2, XKB_KEY_at}, {4, XKB_KEY_3, XKB_KEY_numbersign},
  {5, XKB_KEY_4, XKB_KEY_dollar}, {6, XKB_KEY_5, XKB_KEY_percent}, {7, XKB_KEY_6, XKB_KEY_asciicircum},
  {8, XKB_KEY_7, XKB_KEY_ampersand}, {9, XKB_KEY_8, XKB_KEY_asterisk}, {10, XKB_KEY_9, XKB_KEY_parenleft},
  {11, XKB_KEY_0, XKB_KEY_parenright}, {12, XKB_KEY_minus, XKB_KEY_underscore}, {13, XKB_KEY_equal, XKB_KEY_plus},
  {14, XKB_KEY_BackSpace, 0}, {15, XKB_KEY_Tab, 0},
  {16, XKB_KEY_q, XKB_KEY_Q}, {17, XKB_KEY_w, XKB_KEY_W}, {18, XKB_KEY_e, XKB_KEY_E}, {19, XKB_KEY_r, XKB_KEY_R},
  {20, XKB_KEY_t, XKB_KEY_T}, {21, XKB_KEY_y, XKB_KEY_Y}, {22, XKB_KEY_u, XKB_KEY_U}, {23, XKB_KEY_i, XKB_KEY_I},
  {24, XKB_KEY_o, XKB_KEY_O}, {25, XKB_KEY_p, XKB_KEY_P}, {26, XKB_KEY_bracketleft, XKB_KEY_braceleft},
  {27, XKB_KEY_bracketright, XKB_KEY_braceright}, {28, XKB_KEY_Return, 0}, {29, XKB_KEY_Control_L, 0},
  {30, XKB_KEY_a, XKB_KEY_A}, {31, XKB_KEY_s, XKB_KEY_S}, {32, XKB_KEY_d, XKB_KEY_D}, {33, XKB_KEY_f, XKB_KEY_F},
  {34, XKB_KEY_g, XKB_KEY_G}, {35, XKB_KEY_h, XKB_KEY_H}, {36, XKB_KEY_j, XKB_KEY_J}, {37, XKB_KEY_k, XKB_KEY_K},
  {38, XKB_KEY_l, XKB_KEY_L}, {39, XKB_KEY_semicolon, XKB_KEY_colon}, {40, XKB_KEY_apostrophe, XKB_KEY_quotedbl},
  {41, XKB_KEY_grave, XKB_KEY_asciitilde}, {42, XKB_KEY_Shift_L, 0}, {43, XKB_KEY_backslash, XKB_KEY_bar},
  {44, XKB_KEY_z, XKB_KEY_Z}, {45, XKB_KEY_x, XKB_KEY_X}, {46, XKB_KEY_c, XKB_KEY_C}, {47, XKB_KEY_v, XKB_KEY_V},
  {48, XKB_KEY_b, XKB_KEY_B}, {49, XKB_KEY_n, XKB_KEY_N}, {50, XKB_KEY_m, XKB_KEY_M}, {51, XKB_KEY_comma, XKB_KEY_less},
  {52, XKB_KEY_period, XKB_KEY_greater}, {53, XKB_KEY_slash, XKB_KEY_question}, {56, XKB_KEY_Alt_L, 0},
  {57, XKB_KEY_space, 0},
  {59, XKB_KEY_F1, 0}, {60, XKB_KEY_F2, 0}, {61, XKB_KEY_F3, 0}, {62, XKB_KEY_F4, 0}, {63, XKB_KEY_F5, 0},
  {64, XKB_KEY_F6, 0}, {65, XKB_KEY_F7, 0}, {66, XKB_KEY_F8, 0}, {67, XKB_KEY_F9, 0}, {68, XKB_KEY_F10, 0},
  {87, XKB_KEY_F11, 0}, {88, XKB_KEY_F12, 0},
  {102, XKB_KEY_Home, 0}, {103, XKB_KEY_Up, 0}, {104, XKB_KEY_Prior, 0}, {105, XKB_KEY_Left, 0},
  {106, XKB_KEY_Right, 0}, {107, XKB_KEY_End, 0}, {108, XKB_KEY_Down, 0}, {109, XKB_KEY_Next, 0},
  {111, XKB_KEY_Delete, 0}, {125, XKB_KEY_Super_L, 0},
};
#define NUS (sizeof US / sizeof US[0])
/* Only the keys used so far go in the keymap, as the old growing table did: a keymap holding the whole layout
 * made Chromium segfault on about half of fresh launches at the first key (measured 2026-09-26: 3-5 of 6 crashes;
 * a small growing keymap: 0 of 6 for weeks). */
static int used[NUS];
#define KEY_LEFTSHIFT 42
#define SHIFT_MASK 1

/* Characters outside the US layout: one single-level keycode each, from evdev EXTRA_BASE up. */
#define EXTRA_BASE 184
#define MAX_EXTRA 60
static xkb_keysym_t extras[MAX_EXTRA];
static int nextra = 0;
static int keymap_dirty = 1; /* the keymap must be uploaded before the first key */

static uint32_t now_ms(void) {
  struct timeval tv; gettimeofday(&tv, NULL);
  return (uint32_t)(tv.tv_sec * 1000 + tv.tv_usec / 1000);
}

static void registry_global(void *d, struct wl_registry *r, uint32_t name, const char *iface, uint32_t version) {
  (void)d;
  if (!seat && strcmp(iface, wl_seat_interface.name) == 0) seat = wl_registry_bind(r, name, &wl_seat_interface, version < 5 ? version : 5);
  else if (!manager && strcmp(iface, zwp_virtual_keyboard_manager_v1_interface.name) == 0) manager = wl_registry_bind(r, name, &zwp_virtual_keyboard_manager_v1_interface, 1);
}
static void registry_remove(void *d, struct wl_registry *r, uint32_t name) { (void)d; (void)r; (void)name; }
static const struct wl_registry_listener registry_listener = { registry_global, registry_remove };

/* Where a keysym is typed: its evdev keycode and whether Shift is held. Adds a character outside the US
 * layout to the extras (marking the keymap dirty). Returns 0, or -1 when invalid or the extras are full. */
static int locate(xkb_keysym_t ks, uint32_t *code, int *shift) {
  if (ks == XKB_KEY_NoSymbol) return -1;
  if (ks == XKB_KEY_KP_Enter) ks = XKB_KEY_Return;
  for (size_t i = 0; i < NUS; i++) {
    int hit = US[i].base == ks ? 1 : (US[i].shifted && US[i].shifted == ks) ? 2 : 0;
    if (!hit) continue;
    *code = US[i].code;
    *shift = hit == 2;
    if (!used[i]) { used[i] = 1; keymap_dirty = 1; }
    /* A shifted character also needs the Shift key itself in the keymap. */
    if (hit == 2) for (size_t j = 0; j < NUS; j++) if (US[j].code == KEY_LEFTSHIFT && !used[j]) { used[j] = 1; keymap_dirty = 1; }
    return 0;
  }
  for (int i = 0; i < nextra; i++) if (extras[i] == ks) { *code = (uint32_t)(EXTRA_BASE + i); *shift = 0; return 0; }
  if (nextra >= MAX_EXTRA) return -1;
  extras[nextra] = ks;
  keymap_dirty = 1;
  *code = (uint32_t)(EXTRA_BASE + nextra++);
  *shift = 0;
  return 0;
}

static void sym_name(xkb_keysym_t ks, char *name, size_t cap) {
  if (xkb_keysym_get_name(ks, name, cap) <= 0) snprintf(name, cap, "U%04X", (unsigned)ks);
}

/* The xkb keymap: the US keys (two levels where they have a shifted symbol) plus the extras; xkb keycode =
 * evdev + 8. The modifier keys are mapped so a page sees Shift/Control/Alt/Super as real modifiers. */
static char *build_keymap(size_t *out_len) {
  size_t cap = 8192 + (size_t)(NUS + nextra) * 128, len = 0;
  char *s = malloc(cap);
  if (!s) return NULL;
  /* maximum = the highest keycode actually used. Declaring 255 made Chromium segfault on about half of fresh
   * launches at the first key (measured 2026-09-26: 3/6 and 4/6 crashes with 255, 0/6 with the exact maximum). */
  uint32_t top = 1;
  for (size_t i = 0; i < NUS; i++) if (used[i] && US[i].code > top) top = US[i].code;
  if (nextra) top = (uint32_t)(EXTRA_BASE + nextra - 1);
  len += snprintf(s + len, cap - len, "xkb_keymap {\nxkb_keycodes \"hk\" {\n\tminimum = 8;\n\tmaximum = %u;\n", top + 8);
  for (size_t i = 0; i < NUS; i++) if (used[i]) len += snprintf(s + len, cap - len, "\t<E%u> = %u;\n", US[i].code, US[i].code + 8);
  for (int i = 0; i < nextra; i++) len += snprintf(s + len, cap - len, "\t<E%d> = %d;\n", EXTRA_BASE + i, EXTRA_BASE + i + 8);
  len += snprintf(s + len, cap - len,
    "};\n"
    "xkb_types \"hk\" {\n\tvirtual_modifiers NumLock;\n"
    "\ttype \"ONE_LEVEL\" {\n\t\tmodifiers= none;\n\t\tlevel_name[Level1]= \"Any\";\n\t};\n"
    "\ttype \"TWO_LEVEL\" {\n\t\tmodifiers= Shift;\n\t\tmap[Shift]= Level2;\n\t\tlevel_name[Level1]= \"Base\";\n\t\tlevel_name[Level2]= \"Shift\";\n\t};\n"
    "};\n"
    "xkb_compatibility \"hk\" {\n};\n"
    "xkb_symbols \"hk\" {\n");
  for (size_t i = 0; i < NUS; i++) {
    if (!used[i]) continue;
    char a[64], b[64];
    sym_name(US[i].base, a, sizeof a);
    if (US[i].shifted) { sym_name(US[i].shifted, b, sizeof b); len += snprintf(s + len, cap - len, "\tkey <E%u> { type= \"TWO_LEVEL\", [ %s, %s ] };\n", US[i].code, a, b); }
    else len += snprintf(s + len, cap - len, "\tkey <E%u> { [ %s ] };\n", US[i].code, a);
  }
  for (int i = 0; i < nextra; i++) {
    char a[64];
    sym_name(extras[i], a, sizeof a);
    len += snprintf(s + len, cap - len, "\tkey <E%d> { [ %s ] };\n", EXTRA_BASE + i, a);
  }
  static const struct { uint32_t code; const char *mod; } MODS[] = { {42, "Shift"}, {29, "Control"}, {56, "Mod1"}, {125, "Mod4"} };
  for (size_t m = 0; m < sizeof MODS / sizeof MODS[0]; m++)
    for (size_t i = 0; i < NUS; i++) if (used[i] && US[i].code == MODS[m].code) len += snprintf(s + len, cap - len, "\tmodifier_map %s { <E%u> };\n", MODS[m].mod, MODS[m].code);
  len += snprintf(s + len, cap - len, "};\n};\n");
  *out_len = len;
  return s;
}

/* Upload the current keymap to the persistent device (only when dirty). The device
 * is never recreated — that persistence is the whole point. Returns 0 on success. */
static int upload_keymap(struct wl_display *display) {
  if (!keymap_dirty) return 0;
  size_t len = 0;
  char *text = build_keymap(&len);
  if (!text) return -1;
  int fd = memfd_create("hk-keymap", MFD_CLOEXEC);
  if (fd < 0) { free(text); return -1; }
  size_t size = len + 1; /* include the trailing NUL, as the compositor mmaps it */
  if (ftruncate(fd, (off_t)size) < 0) { close(fd); free(text); return -1; }
  char *map = mmap(NULL, size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
  if (map == MAP_FAILED) { close(fd); free(text); return -1; }
  memcpy(map, text, len);
  map[len] = '\0';
  munmap(map, size);
  free(text);
  zwp_virtual_keyboard_v1_keymap(keyboard, WL_KEYBOARD_KEYMAP_FORMAT_XKB_V1, fd, (uint32_t)size);
  close(fd);
  if (wl_display_flush(display) < 0 || wl_display_roundtrip(display) < 0) return -1;
  keymap_dirty = 0;
  return 0;
}

/* Between keystrokes, like a person typing (and like wtype -d 25): a React input sees each one land. */
#define KEY_GAP_US 25000

/* Press then release one evdev keycode, holding Shift (key and modifier state) when asked, on top of any
 * modifiers the caller already set (mods: X core mask, sent while the key is down). */
static void tap_code(uint32_t code, int shift, uint32_t mods) {
  uint32_t held = mods | (shift ? SHIFT_MASK : 0);
  if (shift) zwp_virtual_keyboard_v1_key(keyboard, now_ms(), KEY_LEFTSHIFT, WL_KEYBOARD_KEY_STATE_PRESSED);
  if (held) zwp_virtual_keyboard_v1_modifiers(keyboard, held, 0, 0, 0);
  zwp_virtual_keyboard_v1_key(keyboard, now_ms(), code, WL_KEYBOARD_KEY_STATE_PRESSED);
  zwp_virtual_keyboard_v1_key(keyboard, now_ms(), code, WL_KEYBOARD_KEY_STATE_RELEASED);
  if (shift) zwp_virtual_keyboard_v1_key(keyboard, now_ms(), KEY_LEFTSHIFT, WL_KEYBOARD_KEY_STATE_RELEASED);
  if (held) zwp_virtual_keyboard_v1_modifiers(keyboard, 0, 0, 0, 0);
}

/* Decode one UTF-8 codepoint from p (len bytes remain); returns bytes consumed, 0 on error. */
static int utf8_next(const unsigned char *p, size_t len, uint32_t *cp) {
  if (len == 0) return 0;
  if (p[0] < 0x80) { *cp = p[0]; return 1; }
  if ((p[0] & 0xe0) == 0xc0 && len >= 2 && (p[1] & 0xc0) == 0x80) { *cp = ((p[0] & 0x1f) << 6) | (p[1] & 0x3f); return 2; }
  if ((p[0] & 0xf0) == 0xe0 && len >= 3 && (p[1] & 0xc0) == 0x80 && (p[2] & 0xc0) == 0x80) { *cp = ((p[0] & 0x0f) << 12) | ((p[1] & 0x3f) << 6) | (p[2] & 0x3f); return 3; }
  if ((p[0] & 0xf8) == 0xf0 && len >= 4 && (p[1] & 0xc0) == 0x80 && (p[2] & 0xc0) == 0x80 && (p[3] & 0xc0) == 0x80) { *cp = ((p[0] & 0x07) << 18) | ((p[1] & 0x3f) << 12) | ((p[2] & 0x3f) << 6) | (p[3] & 0x3f); return 4; }
  return 0;
}

static const signed char B64[256] = { /* -1 invalid, -2 padding */
  ['A']=0,['B']=1,['C']=2,['D']=3,['E']=4,['F']=5,['G']=6,['H']=7,['I']=8,['J']=9,['K']=10,['L']=11,['M']=12,
  ['N']=13,['O']=14,['P']=15,['Q']=16,['R']=17,['S']=18,['T']=19,['U']=20,['V']=21,['W']=22,['X']=23,['Y']=24,['Z']=25,
  ['a']=26,['b']=27,['c']=28,['d']=29,['e']=30,['f']=31,['g']=32,['h']=33,['i']=34,['j']=35,['k']=36,['l']=37,['m']=38,
  ['n']=39,['o']=40,['p']=41,['q']=42,['r']=43,['s']=44,['t']=45,['u']=46,['v']=47,['w']=48,['x']=49,['y']=50,['z']=51,
  ['0']=52,['1']=53,['2']=54,['3']=55,['4']=56,['5']=57,['6']=58,['7']=59,['8']=60,['9']=61,['+']=62,['/']=63,['=']=-2,
};
/* Decode base64 into out (caller-sized >= 3*len/4). Returns byte count, -1 on a bad char. */
static long b64_decode(const char *in, unsigned char *out) {
  long n = 0; int bits = 0, acc = 0;
  for (const char *p = in; *p; p++) {
    if (*p == '=' ) break;
    signed char v = B64[(unsigned char)*p];
    if (v < 0) return -1;
    acc = (acc << 6) | v; bits += 6;
    if (bits >= 8) { bits -= 8; out[n++] = (unsigned char)((acc >> bits) & 0xff); }
  }
  return n;
}

struct named { const char *name; xkb_keysym_t sym; };
static const struct named NAMED[] = {
  { "Return", XKB_KEY_Return }, { "Enter", XKB_KEY_Return }, { "Tab", XKB_KEY_Tab },
  { "BackSpace", XKB_KEY_BackSpace }, { "Delete", XKB_KEY_Delete }, { "Escape", XKB_KEY_Escape },
  { "space", XKB_KEY_space }, { "Left", XKB_KEY_Left }, { "Right", XKB_KEY_Right },
  { "Up", XKB_KEY_Up }, { "Down", XKB_KEY_Down }, { "Home", XKB_KEY_Home }, { "End", XKB_KEY_End },
  { "Prior", XKB_KEY_Prior }, { "Next", XKB_KEY_Next }, { "Page_Up", XKB_KEY_Prior }, { "Page_Down", XKB_KEY_Next },
  { "F1", XKB_KEY_F1 }, { "F2", XKB_KEY_F2 }, { "F3", XKB_KEY_F3 }, { "F4", XKB_KEY_F4 }, { "F5", XKB_KEY_F5 },
  { "F6", XKB_KEY_F6 }, { "F7", XKB_KEY_F7 }, { "F8", XKB_KEY_F8 }, { "F9", XKB_KEY_F9 }, { "F10", XKB_KEY_F10 },
  { "F11", XKB_KEY_F11 }, { "F12", XKB_KEY_F12 },
};
static xkb_keysym_t named_sym(const char *name) {
  for (size_t i = 0; i < sizeof NAMED / sizeof NAMED[0]; i++) if (strcmp(NAMED[i].name, name) == 0) return NAMED[i].sym;
  return XKB_KEY_NoSymbol;
}
/* X core modifier mask bits. */
static uint32_t mod_bit(const char *m) {
  if (strcmp(m, "shift") == 0) return 1;
  if (strcmp(m, "ctrl") == 0) return 4;
  if (strcmp(m, "alt") == 0) return 8;   /* Mod1 */
  if (strcmp(m, "logo") == 0) return 64; /* Mod4 */
  return 0;
}

int main(void) {
  setvbuf(stdout, NULL, _IOLBF, 0);
  struct wl_display *display = wl_display_connect(NULL);
  if (!display) { fprintf(stderr, "headless_keyboard: no wayland display\n"); return 2; }
  struct wl_registry *registry = wl_display_get_registry(display);
  wl_registry_add_listener(registry, &registry_listener, NULL);
  wl_display_roundtrip(display);
  if (!seat || !manager) { fprintf(stderr, "headless_keyboard: seat or zwp_virtual_keyboard_manager_v1 missing\n"); return 3; }
  keyboard = zwp_virtual_keyboard_manager_v1_create_virtual_keyboard(manager, seat);
  wl_display_roundtrip(display);
  if (upload_keymap(display) < 0) { fprintf(stderr, "headless_keyboard: keymap upload failed\n"); return 4; }
  printf("ready\n"); fflush(stdout);

  char *line = NULL; size_t linecap = 0; ssize_t n;
  while ((n = getline(&line, &linecap, stdin)) >= 0) {
    while (n > 0 && (line[n - 1] == '\n' || line[n - 1] == '\r')) line[--n] = '\0';
    if (n == 0) continue;
    char *sp = strchr(line, ' ');
    char *cmd = line, *arg = sp ? sp + 1 : NULL;
    if (sp) *sp = '\0';

    if (strcmp(cmd, "quit") == 0) break;

    if (strcmp(cmd, "text") == 0 && arg) {
      unsigned char *buf = malloc(strlen(arg)); /* decoded <= encoded length */
      if (!buf) { printf("err oom\n"); continue; }
      long blen = b64_decode(arg, buf);
      if (blen < 0) { free(buf); printf("err base64\n"); continue; }
      /* First locate every keysym (may add extras once), upload, then type in order. */
      int ok = 1;
      for (long off = 0; off < blen && ok; ) {
        uint32_t cp; int adv = utf8_next(buf + off, (size_t)(blen - off), &cp);
        if (adv == 0) { ok = 0; break; }
        off += adv;
        uint32_t code; int shift;
        if (locate(xkb_utf32_to_keysym(cp == '\n' ? '\r' : cp), &code, &shift) < 0) ok = 0;
      }
      if (!ok) { free(buf); printf("err text\n"); continue; }
      if (upload_keymap(display) < 0) { free(buf); printf("err keymap\n"); break; }
      for (long off = 0; off < blen; ) {
        uint32_t cp; int adv = utf8_next(buf + off, (size_t)(blen - off), &cp); off += adv;
        uint32_t code; int shift;
        if (locate(xkb_utf32_to_keysym(cp == '\n' ? '\r' : cp), &code, &shift) == 0) {
          tap_code(code, shift, 0);
          if (wl_display_flush(display) < 0) break;
          usleep(KEY_GAP_US);
        }
      }
      free(buf);
      if (wl_display_flush(display) < 0 || wl_display_roundtrip(display) < 0) { printf("err display\n"); break; }
      printf("ok\n");
    } else if (strcmp(cmd, "key") == 0 && arg) {
      char *ms = strchr(arg, ' ');
      char *mods = ms ? ms + 1 : NULL;
      if (ms) *ms = '\0';
      xkb_keysym_t ks = named_sym(arg);
      if (ks == XKB_KEY_NoSymbol) {
        /* A single printable character (e.g. ctrl+a / ctrl+c): its own keysym. */
        uint32_t cp; int adv = utf8_next((const unsigned char *)arg, strlen(arg), &cp);
        if (adv > 0 && arg[adv] == '\0') ks = xkb_utf32_to_keysym(cp);
      }
      if (ks == XKB_KEY_NoSymbol) { printf("err key\n"); continue; }
      uint32_t mask = 0;
      if (mods) { for (char *t = strtok(mods, "+"); t; t = strtok(NULL, "+")) { uint32_t b = mod_bit(t); if (!b) { mask = 0xffffffff; break; } mask |= b; } }
      if (mask == 0xffffffff) { printf("err mods\n"); continue; }
      uint32_t code; int shift;
      if (locate(ks, &code, &shift) < 0) { printf("err full\n"); continue; }
      if (upload_keymap(display) < 0) { printf("err keymap\n"); break; }
      /* Ctrl+A is the A key with Control held, whatever case was asked for. */
      if (mask & SHIFT_MASK) shift = 0;
      tap_code(code, shift, mask);
      if (wl_display_flush(display) < 0 || wl_display_roundtrip(display) < 0) { printf("err display\n"); break; }
      printf("ok\n");
    } else {
      printf("err syntax\n");
    }
  }
  free(line);
  if (keyboard) zwp_virtual_keyboard_v1_destroy(keyboard);
  wl_display_disconnect(display);
  return 0;
}
