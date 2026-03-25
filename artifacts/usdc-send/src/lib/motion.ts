import type { Variants, Transition } from "framer-motion";

// ── Spring presets ─────────────────────────────────────────────────────────────
export const spring: Transition = { type: "spring", stiffness: 400, damping: 30 };
export const springGentle: Transition = { type: "spring", stiffness: 200, damping: 25 };
export const easeOut: Transition = { duration: 0.5, ease: [0.25, 0.46, 0.45, 0.94] };

// ── Shared variants ────────────────────────────────────────────────────────────

export const fadeUp: Variants = {
  hidden: { opacity: 0, y: 24 },
  show: { opacity: 1, y: 0, transition: easeOut },
};

export const fadeDown: Variants = {
  hidden: { opacity: 0, y: -16 },
  show: { opacity: 1, y: 0, transition: easeOut },
};

export const fadeIn: Variants = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { duration: 0.4 } },
};

export const scaleIn: Variants = {
  hidden: { opacity: 0, scale: 0.93 },
  show: { opacity: 1, scale: 1, transition: springGentle },
};

export const slideLeft: Variants = {
  hidden: { opacity: 0, x: -32 },
  show: { opacity: 1, x: 0, transition: easeOut },
};

export const slideRight: Variants = {
  hidden: { opacity: 0, x: 32 },
  show: { opacity: 1, x: 0, transition: easeOut },
};

// ── Stagger container ──────────────────────────────────────────────────────────

export const staggerContainer = (stagger = 0.1, delayStart = 0): Variants => ({
  hidden: {},
  show: {
    transition: {
      staggerChildren: stagger,
      delayChildren: delayStart,
    },
  },
});

// ── Page-level transition (used with AnimatePresence in App.tsx) ───────────────
export const pageTransition: Variants = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.4, ease: "easeOut" } },
  exit: { opacity: 0, y: -8, transition: { duration: 0.25, ease: "easeIn" } },
};

// ── Error/shake animation ──────────────────────────────────────────────────────
export const shake: Variants = {
  hidden: { x: 0 },
  show: {
    x: [0, -8, 8, -6, 6, -3, 3, 0],
    transition: { duration: 0.5, ease: "easeInOut" },
  },
};
