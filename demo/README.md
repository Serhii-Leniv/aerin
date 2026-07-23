# Demo tapes

Recorded with [Charm's vhs](https://github.com/charmbracelet/vhs). The `.tape` files are the scripts; the GIFs are the output.

To (re)record — needs a working provider key (or Ollama for `local.tape`) and a repo with a small failing test for `quickstart.tape`:

```sh
# install vhs (needs ttyd + ffmpeg): https://github.com/charmbracelet/vhs#installation
vhs demo/quickstart.tape   # -> demo/demo.gif
vhs demo/local.tape        # -> demo/local.gif
```

Then uncomment the hero image in README.md and commit the GIFs. Keep them under ~5 MB (GitHub renders large GIFs poorly) — trim `Sleep`s or lower `Set Width` if needed.
