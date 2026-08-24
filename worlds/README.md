# Worlds catalog

Shared catalog of worlds (harness + case-study pointers). The Lab UI that consumed this catalog lives **outside** this repo (`/home/mark/fausth-lab` / CasaOS). The CLI and `case-studies/` are the in-repo entry points.

| Id | Status | Notes |
|----|--------|-------|
| [greenhouse](greenhouse/) | approved | Track A + live catch-rate |
| [coding-sandbox](coding-sandbox/) | approved | Coding CB example + case-study |
| [adversarial](adversarial/) | approved | Side-effect security matrix |
| [swe-bench](swe-bench/) | approved | HRI Track S — SWE-bench Lite N=25 |
| [tau-bench](tau-bench/) | approved | HRI Track T — τ-bench retail N=25 |
| [chess](chess/) | approved | Procedural wind tunnel — legality, replay, terminal claims |

Each world has a `world.yml` (`id`, `title`, `status`, `harness` / `track_a`, `case_study_manifest`, scoring hooks).
