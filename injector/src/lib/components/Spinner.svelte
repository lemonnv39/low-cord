<script lang="ts">
    // Indicateur d'activité façon terminal : une roue braille qui tourne en
    // continu (remplace le curseur clignotant, plus doux à l'œil).
    const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    let i = $state(0);

    $effect(() => {
        const t = setInterval(() => (i = (i + 1) % FRAMES.length), 80);
        return () => clearInterval(t);
    });
</script>

<span class="spin" aria-hidden="true">{FRAMES[i]}</span>

<style>
    .spin {
        display: inline-block;
        width: 1.2ch;
        margin-left: 6px;
        text-align: center;
        color: var(--fg-bright);
    }
</style>
