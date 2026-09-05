import type { TransientCanvasPluginContextV1 } from 'cordisx/contracts'

interface Particle {
  readonly x: number
  readonly y: number
  readonly vx: number
  readonly vy: number
  readonly size: number
  readonly color: string
  readonly spin: number
}

const colors = ['#ff4d6d', '#ffd166', '#06d6a0', '#4cc9f0', '#8b5cf6', '#ff8c42'] as const

export async function apply(ctx: TransientCanvasPluginContextV1): Promise<void> {
  const handle = await ctx.transientCanvas.register({
    $schema:
      'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/transient-canvas-registration.v1.schema.json',
    schemaVersion: 1,
    id: 'confetti',
    pointId: 'composer.submit.effects',
    durationMs: 2400,
    reducedMotion: 'static',
  }, ({ canvas, width, height, reducedMotion, signal }) => {
    const context = canvas.getContext('2d')
    if (context === null) return
    const particles: readonly Particle[] = Array.from({ length: reducedMotion ? 48 : 120 }, (_, index) => ({
      x: width * (0.12 + Math.random() * 0.76),
      y: height * (reducedMotion ? 0.16 + Math.random() * 0.68 : 0.52),
      vx: (Math.random() - 0.5) * width * 0.42,
      vy: reducedMotion ? 0 : -(0.28 + Math.random() * 0.34) * height,
      size: 5 + Math.random() * 9,
      color: colors[index % colors.length]!,
      spin: (Math.random() - 0.5) * 10,
    }))
    const started = performance.now()
    const draw = (now: number): void => {
      if (signal.aborted) return
      const elapsed = Math.max(0, (now - started) / 1000)
      context.clearRect(0, 0, width, height)
      for (const particle of particles) {
        const x = particle.x + particle.vx * elapsed
        const y = particle.y + particle.vy * elapsed + height * 0.38 * elapsed * elapsed
        context.save()
        context.translate(x, y)
        context.rotate(particle.spin * elapsed)
        context.fillStyle = particle.color
        context.fillRect(-particle.size / 2, -particle.size / 3, particle.size, particle.size * 0.66)
        context.restore()
      }
      if (!reducedMotion) requestAnimationFrame(draw)
    }
    draw(started)
  })
  ctx.onDispose(() => handle.dispose())
}
