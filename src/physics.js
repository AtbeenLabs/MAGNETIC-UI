export class MagneticMotion {
  constructor({ selector = '.magnetic, [data-follow-force]', maxPixels = 42, onFrame = () => {} } = {}) {
    this.elements = [...document.querySelectorAll(selector)];
    this.maxPixels = maxPixels;
    this.onFrame = onFrame;
    this.target = { x: 0, y: 0, strength: 0 };
    this.position = { x: 0, y: 0 };
    this.velocity = { x: 0, y: 0 };
    this.settings = { force: 1, smoothness: 0.82 };
    this.lastTime = 0;
    this.reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    this.running = false;
    this.frameId = null;
    this.handleVisibility = () => {
      if (document.hidden) this.pause();
      else this.resume();
    };
    document.addEventListener('visibilitychange', this.handleVisibility);
    this.resume();
  }

  setTarget(x, y, strength = 1) {
    const magnitude = Math.hypot(x, y);
    if (magnitude > 1) { x /= magnitude; y /= magnitude; }
    this.target = {
      x: Number.isFinite(x) ? x : 0,
      y: Number.isFinite(y) ? y : 0,
      strength: Math.max(0, Math.min(1, Number(strength) || 0)),
    };
  }

  setSettings(settings = {}) {
    if (Number.isFinite(settings.force)) this.settings.force = Math.max(0.1, Math.min(3, settings.force));
    if (Number.isFinite(settings.smoothness)) this.settings.smoothness = Math.max(0.1, Math.min(1, settings.smoothness));
  }

  reset() { this.setTarget(0, 0, 0); }

  resume() {
    if (this.running || document.hidden) return;
    this.running = true;
    this.lastTime = 0;
    this.frameId = requestAnimationFrame((time) => this.tick(time));
  }

  pause() {
    this.running = false;
    if (this.frameId !== null) cancelAnimationFrame(this.frameId);
    this.frameId = null;
  }

  tick(time) {
    if (!this.running) return;
    const dt = this.lastTime ? Math.min((time - this.lastTime) / 1000, 0.04) : 1 / 60;
    this.lastTime = time;

    if (this.reducedMotion) {
      this.position.x = 0; this.position.y = 0;
      this.velocity.x = 0; this.velocity.y = 0;
    } else {
      const targetScale = this.maxPixels * this.settings.force * this.target.strength;
      const targetX = this.target.x * targetScale;
      const targetY = this.target.y * targetScale;
      const smoothness = this.settings.smoothness;
      const stiffness = 230 - smoothness * 125;
      const damping = 22 - smoothness * 8;
      for (const axis of ['x', 'y']) {
        const destination = axis === 'x' ? targetX : targetY;
        const acceleration = (destination - this.position[axis]) * stiffness;
        this.velocity[axis] = (this.velocity[axis] + acceleration * dt) * Math.exp(-damping * dt);
        this.position[axis] += this.velocity[axis] * dt;
        if (Math.abs(destination - this.position[axis]) < 0.015 && Math.abs(this.velocity[axis]) < 0.015) {
          this.position[axis] = destination;
          this.velocity[axis] = 0;
        }
      }
    }

    for (const element of this.elements) {
      const depth = Number(element.dataset.magnetic ?? element.dataset.depth ?? 1);
      const safeDepth = Number.isFinite(depth) ? depth : 1;
      element.style.setProperty('--pull-x', `${(this.position.x * safeDepth).toFixed(2)}px`);
      element.style.setProperty('--pull-y', `${(this.position.y * safeDepth).toFixed(2)}px`);
    }

    const currentMagnitude = Math.hypot(this.position.x, this.position.y);
    document.documentElement.style.setProperty('--field-opacity', String(Math.min(0.65, currentMagnitude / 65)));
    this.onFrame({
      x: this.position.x,
      y: this.position.y,
      active: currentMagnitude > 0.7 || this.target.strength > 0.03,
      vectorX: this.target.x,
      vectorY: this.target.y,
    });
    this.frameId = requestAnimationFrame((nextTime) => this.tick(nextTime));
  }

  destroy() {
    this.pause();
    document.removeEventListener('visibilitychange', this.handleVisibility);
    this.setTarget(0, 0, 0);
    for (const element of this.elements) {
      element.style.setProperty('--pull-x', '0px');
      element.style.setProperty('--pull-y', '0px');
    }
  }
}
