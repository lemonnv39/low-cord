<script lang="ts">
    // Fond sobre monochrome : deux halos BLANCS diffus qui respirent lentement,
    // un champ de particules très discrètes qui montent doucement, sur un noir
    // profond + trame technique + vignette. Discret, jamais envahissant (tout
    // en transform/opacity, GPU-friendly). `dimmed` l'atténue pendant une
    // installation pour focaliser l'UI.
    let { dimmed = false }: { dimmed?: boolean } = $props();

    // Particules générées une fois, réparties de façon pseudo-aléatoire mais
    // stable (pas de re-render). Durées/délais variés pour éviter tout "pouls"
    // synchronisé visible.
    const PARTICLES = Array.from({ length: 18 }, (_, i) => {
        const r = (seed: number) => {
            const x = Math.sin((i + 1) * seed) * 10000;
            return x - Math.floor(x);
        };
        return {
            left: Math.round(r(12.9898) * 100),
            size: +(1 + r(78.233) * 2).toFixed(2),
            duration: +(16 + r(43.17) * 20).toFixed(2),
            delay: +(-r(91.7) * 30).toFixed(2),
            opacity: +(0.05 + r(27.3) * 0.1).toFixed(3),
        };
    });
</script>

<div class="backdrop" class:dimmed aria-hidden="true">
    <div class="glow glow-a"></div>
    <div class="glow glow-b"></div>
    <div class="particles">
        {#each PARTICLES as p}
            <span
                class="particle"
                style={`left:${p.left}%; width:${p.size}px; height:${p.size}px; --dur:${p.duration}s; --delay:${p.delay}s; --maxo:${p.opacity};`}
            ></span>
        {/each}
    </div>
    <div class="grid"></div>
    <div class="vignette"></div>
</div>

<style>
    .backdrop {
        position: fixed;
        inset: 0;
        z-index: 0;
        overflow: hidden;
        background: radial-gradient(140% 120% at 50% -20%, #141416 0%, var(--bg) 62%);
        transition: opacity var(--duration-slow) var(--ease-out);
    }

    .backdrop.dimmed { opacity: 0.4; }

    .glow {
        position: absolute;
        border-radius: 50%;
        filter: blur(100px);
        will-change: transform;
    }

    .glow-a {
        width: 460px;
        height: 460px;
        top: -200px;
        left: -120px;
        background: radial-gradient(circle, rgba(255, 255, 255, 0.16), transparent 70%);
        animation: drift-a 38s var(--ease-in-out) infinite;
    }

    .glow-b {
        width: 420px;
        height: 420px;
        bottom: -200px;
        right: -100px;
        background: radial-gradient(circle, rgba(255, 255, 255, 0.10), transparent 70%);
        animation: drift-b 46s var(--ease-in-out) infinite;
    }

    /* Champ de particules : points blancs très faibles qui montent lentement
       et disparaissent en haut, boucle infinie décalée. */
    .particles {
        position: absolute;
        inset: 0;
        overflow: hidden;
    }
    .particle {
        position: absolute;
        bottom: -6px;
        border-radius: 50%;
        background: #ffffff;
        opacity: 0;
        will-change: transform, opacity;
        animation: rise var(--dur) linear var(--delay) infinite;
    }

    /* Trame très discrète, façon "surface technique". */
    .grid {
        position: absolute;
        inset: 0;
        background-image:
            linear-gradient(rgba(255, 255, 255, 0.022) 1px, transparent 1px),
            linear-gradient(90deg, rgba(255, 255, 255, 0.022) 1px, transparent 1px);
        background-size: 34px 34px;
        mask-image: radial-gradient(120% 90% at 50% 30%, #000 40%, transparent 85%);
        -webkit-mask-image: radial-gradient(120% 90% at 50% 30%, #000 40%, transparent 85%);
    }

    .vignette {
        position: absolute;
        inset: 0;
        background: radial-gradient(130% 100% at 50% 40%, transparent 55%, rgba(0, 0, 0, 0.5) 100%);
    }

    @keyframes drift-a {
        0%, 100% { transform: translate(0, 0) scale(1); }
        50% { transform: translate(50px, 36px) scale(1.08); }
    }
    @keyframes drift-b {
        0%, 100% { transform: translate(0, 0) scale(1); }
        50% { transform: translate(-44px, -30px) scale(1.1); }
    }
    @keyframes rise {
        0% { transform: translateY(0); opacity: 0; }
        12% { opacity: var(--maxo); }
        88% { opacity: var(--maxo); }
        100% { transform: translateY(-105vh); opacity: 0; }
    }

    @media (prefers-reduced-motion: reduce) {
        .particles { display: none; }
    }
</style>
