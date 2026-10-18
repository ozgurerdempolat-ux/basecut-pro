# What to fix: Premiere's users in their own words

Sample: **63 reviews/posts from 5 sources** (G2, Capterra, Adobe Community forum, Trustpilot, one press article), 2017–2026, mostly 2024–2026. Ranked by `reviews.py` → `feedback.md`.

Honest limits of this sample:
- Below the skill's 100-review target. Reddit and the Hacker News API were unreachable from this workspace; the Apple RSS feed was too.
- G2 and Capterra show no per-review links, so those rows link to the listing page. Quotes there are truncated at ~125 characters by the reading tool.
- The 7 Trustpilot rows are about **Adobe as a company** (billing, cancelling), not Premiere specifically. Trustpilot's Adobe score is 1.2/5 over 7,500+ reviews; G2 is 4.5 (1,675), Capterra 4.7 (574).
- The 17 feature-request rows come from **one author's** list on Adobe's forum (38 votes, status "Not Prioritized"). Treated as thin.

---

## 1. What they hate

| # | problem | reviews | sources | evidence |
| --- | --- | --- | --- | --- |
| 1 | **It crashes, freezes and loses work** | 11 + 11 (two overlapping themes) | 5 | ["Literally cannot go a single session or more than an hour with Premiere crashing"](https://community.adobe.com/t5/premiere-pro-discussions/premiere-pro-2025-crashes-and-takes-too-much-volumes/td-p/14928247) · ["I just spent an entire work day just rebooting premiere from crashes"](https://community.adobe.com/questions-105/ditch-premiere-pro-and-get-davinci-resolve-1531624) |
| 2 | **Heavy on hardware, slow on big/4K projects** | 12 | 3 | ["Premiere Pro can be pretty demanding on my computer. If I'm editing long 4K videos"](https://www.capterra.com/p/233456/Adobe-Premiere-Pro/reviews/3153983/) · ["6K Red footage and it will bring your computer to a grinding halt"](https://community.adobe.com/questions-105/we-pay-a-subscription-for-working-software-1531534) |
| 3 | **Price, and subscription traps on cancel** | 8 + 6 | 4 | ["You are locked in for another 12 months, 50% cancellation cost."](https://www.trustpilot.com/reviews/6a86f07fdabec3b90a6aeaf2) · ["It's extremely expensive when there are free options out there"](https://www.g2.com/products/adobe-premiere-pro/reviews_and_filters) |
| 4 | **Learning curve, dense UI** | 9 | 3 | ["Not a tool you can figure out in an afternoon. The interface is dense"](https://capterra.com/p/233456/Adobe-Premiere-Pro/) · ["Many of the features are hidden behind menus."](https://www.g2.com/products/adobe-premiere-pro/reviews_and_filters) |
| 5 | **Updates break things** | 5 | 2 | ["A huge step backwards compared to the previous versions."](https://www.trustpilot.com/reviews/6a858a849403711dde5f9aed) · ["I honestly hate the new UI. It's not intuitive at all."](https://community.adobe.com/t5/premiere-pro-ideas/reinstate-the-essential-graphics-panel-in-premiere-pro-2025/idi-p/14946070) |
| 6 | Cloud dependency, rent-only *(thin)* | 2 | 2 | ["I wish I could buy the product without the cloud integration."](https://capterra.com/p/233456/Adobe-Premiere-Pro/) |
| 7 | Slow export *(thin)* | 2 | 2 | ["The native method to export videos is incredibly slow."](https://capterra.ca/reviews/1015952/adobe-premiere-pro) |
| 8 | Weak color tools *(thin)* | 2 | 1 | ["It's color correction tools are mediocre at best."](https://community.adobe.com/questions-105/we-pay-a-subscription-for-working-software-1531534) |
| 9 | AI features feel like bloat *(thin)* | 1 + press | 2 | ["they can sometimes feel like bloat"](https://www.g2.com/products/adobe-premiere-pro/reviews_and_filters) |

## 2. What is missing (asked for by name, all thin: one author unless noted)

| request | evidence |
| --- | --- |
| Stabilize and speed-ramp the same clip without nesting | [forum list](https://community.adobe.com/feature-requests-730/the-ultimate-premiere-pro-feature-request-2025-1621187), endorsed by a second user |
| Move tracks up / down | same, endorsed by a second user |
| Animated subtitles | same |
| Real noise cancellation for audio | same |
| Real-time effect previews | same |
| Visible waveforms in multicam | same |
| Output-LUT slot at the end of the color chain | same, endorsed by a second user |
| Precise error log / warnings **before** render | same |
| A project manager that actually works; save to older project version | same |
| Fast AI masking and proper native tracking | same |
| Buy without cloud | Capterra (1) |

## 3. What is unsolved (positioning material)

- **People who cannot afford downtime.** Long projects and paid deliveries; Premiere's crash threads run to 70+ replies with no fix. ("unstable, borderline unable for projects that require months of work")
- **People without workstation hardware.** Laptops, older PCs, 4K phone footage. Resource demands show up even in 5-star reviews.
- **People who want to own their tool.** Rent-only plus cancellation fees.
- **Social-first teams** (our own case): fast vertical edits, animated captions, Turkish transcription. Premiere is built for long-form broadcast first. *Not evidenced by these reviews*: it is our market knowledge, mark as hypothesis.

---

## 4. Fix plan (evidence × cheapness)

| # | what we build | size | skill | evidence |
| --- | --- | --- | --- | --- |
| X1 | **Crash-proof core**: decoding/rendering in a separate process (a crash there never takes the editor down); every edit journaled to disk instantly; reopen exactly where you were | L | architect, build | hate #1 (22 rows, 5 sources) |
| X2 | **Runs on a normal laptop**: automatic background proxies, GPU/iGPU decode first, playback degrades resolution instead of stuttering | L | architect, build | hate #2 (12 rows) |
| X3 | **Preflight before render**: missing media, mismatched fps, odd sizes, effects that will fail, all listed with fixes before export starts | S | build | missing list, crashes on export |
| X4 | **Two modes**: Simple (one-screen, guided) and Pro (full panel layout, Premiere-style keymap) | M | design, build | hate #4 (9 rows) |
| X5 | **Animated word-by-word captions with Turkish transcription** | M | build, backend | missing list (thin) + our market |
| X6 | **Stable UI promise**: no forced layout changes; old layouts keep working; updates are opt-in and roll-back-able | S | architect, deploy | hate #5 |
| X7 | Workflow papercuts: move tracks up/down, stabilize + ramp without nesting, multicam waveforms, output-LUT slot | S each | build | missing list (thin) |
| X8 | **Offline-first, no account needed to edit** | S | architect | hate #6 (thin) |

Pricing/billing complaints (hate #3) go to `/replica-launch`: no cancellation fees, monthly cancels any time, or a perpetual licence option.

All X-rows are added to `features.csv` with `original = no`.

---

## 5. The angle

**A. The editor that doesn't crash**
For editors who lose hours to crashes and freezes, [our app] keeps every edit on disk the moment you make it and isolates rendering so the editor itself stays up.
Evidence: crashes/instability, 22 rows across 5 sources, the #1 theme.

**B. Own it, don't rent it**
For creators tired of rentals and cancellation fees, [our app] is a professional editor you can buy once, or cancel any month without a penalty.
Evidence: price + billing, 14 rows across 4 sources.

**C. Pro power, social speed**
For social media teams who need Premiere-level editing but CapCut-level speed, [our app] puts vertical reframing, animated Turkish captions and one-click export side by side with a full pro timeline.
Evidence: thin in reviews (captions request + complexity theme); strong in our own market.

**Recommendation: A as the core promise, C as the first market.** Stability is the strongest, best-evidenced pain, and it holds for every user. C is who we sell to first (agencies and venues in Turkey) and what the onboarding shows off. B is a pricing decision for `/replica-launch`, not the headline.

Do not use "Premiere" in the app name, ads or store listing. A factual comparison page is a question for a lawyer.
