/**
 * Interactive Animation Module
 * Handles subtle parallax effect for the hero media section.
 */

/**
 * Add gentle parallax effect to the hero media ring on mouse movement.
 * Provides subtle visual feedback without aggressive transforms.
 */
function initializeHeroMediaInteractions() {
  const heroMedia = document.querySelector(".hero-media");
  const mediaRing = document.querySelector(".media-ring");
  const avatarFrame = document.querySelector(".avatar-frame");

  if (!heroMedia || !mediaRing || !avatarFrame) return;

  document.addEventListener("mousemove", (event) => {
    const rect = heroMedia.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;

    // Distance from cursor to media center (only responds when viewport is visible).
    const distanceX = (event.clientX - centerX) / 120;
    const distanceY = (event.clientY - centerY) / 120;

    // Apply gentle offset based on proximity.
    mediaRing.style.transition = "transform 200ms ease-out";
    mediaRing.style.transform = `translate(${distanceX * 0.2}px, ${distanceY * 0.2}px)`;

    avatarFrame.style.transition = "transform 200ms ease-out";
    avatarFrame.style.transform = `translate(${distanceX * 0.3}px, ${distanceY * 0.3}px)`;
  });
}

/**
 * Initialize all interactive animations on page load.
 */
function initializeAnimations() {
  initializeHeroMediaInteractions();
}

// Trigger animations once DOM is ready.
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initializeAnimations);
} else {
  initializeAnimations();
}
