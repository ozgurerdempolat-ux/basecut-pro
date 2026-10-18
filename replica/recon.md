# Recon map: Adobe Premiere (desktop, Windows + macOS)

Scope: **Full application, 1:1 functional parity** (user's explicit choice). Every panel, tool, edit operation, effect family, audio, color, graphics, captions, AI-assist, project/media management and export. Built in phases (see Size).
For: The Base Social, first as an in-house editing tool, product decision (sell / don't sell) left open.
Date: 2026-10-18
Working name: **TBD** (chosen in /replica-brand). No Adobe names, icons, logos, fonts, presets, LUTs or UI artwork enter the clone.

Clean-room note: everything below comes from public help pages, public pricing, public tutorials and community threads. No binaries, bundles or private APIs were inspected. Panel/tool/command *names* are recorded so the behavior is understood; the clone will use its own naming where the name is distinctive (e.g. "Lumetri", "Essential Sound", "Sensei" are brand terms and get replaced).

---

## Sources

| # | source | URL | notes |
| --- | --- | --- | --- |
| 1 | pricing (TR, campaign) | https://www.adobe.com/tr/products/premiere/campaign/pricing.html | given by user; too long a URL to fetch, used #2 instead |
| 2 | pricing (US) | https://www.adobe.com/products/premiere/plans.html?country=US | plans, storage, gen-credits, what is gated |
| 3 | pricing comparison | https://checkthat.ai/brands/adobe-premiere/pricing | all tiers + competitors (Resolve, FCP, CapCut, Runway) |
| 4 | user guide / basic workflow | https://helpx.adobe.com/premiere-pro/using/basic-workflow.html | full TOC: panels, workspaces, every doc section |
| 5 | what's new | https://helpx.adobe.com/sa_en/premiere/desktop/whats-new/whats-new.html | AI feature set (Generative Extend, Media Intelligence, Generate Music beta, Generative Media beta, Enhance Speech, Text-Based Editing, caption translate) |
| 6 | release notes | https://helpx.adobe.com/sa_en/premiere/desktop/whats-new/release-notes.html | updated 2026-10-12; body not machine-readable, revisit in browser |
| 7 | default keyboard shortcuts | https://helpx.adobe.com/au/premiere-pro/using/default-keyboard-shortcuts.chromeless.html | every command + key; the de-facto command inventory |
| 8 | tools panel explained | https://www.premiumbeat.com/blog/an-in-depth-look-at-the-adobe-premiere-pro-editing-tools/ | all 11 timeline tools with behavior |
| 9 | effects & transitions library | https://helpx.adobe.com/se/premiere/desktop/add-video-effects/effects-and-transitions-library/list-of-effects-and-transitions.html | effect bins (19 categories) |
| 10 | color panel walkthrough | https://nofilmschool.com/2018/04/all-you-need-know-about-lumetri-color-premiere-pro | color panel sections + scopes (2018, verify current) |
| 11 | export settings | https://helpx.adobe.com/premiere/desktop/render-and-export/export-files/overview-of-export-settings.html | export groups; body not machine-readable, revisit |
| 12 | system requirements | https://helpx.adobe.com/la/premiere-pro/system-requirements.html | HW accel decode/encode, GPU, Metal |
| 13 | community: Essential Graphics → Properties split | https://community.adobe.com/t5/premiere-pro-ideas/reinstate-the-essential-graphics-panel-in-premiere-pro-2025/idi-p/14946070 | v25 UI change and user pain |
| 14 | community: caption style editing broken in 25.0 | https://community.adobe.com/t5/premiere-pro-discussions/can-t-edit-caption-style-in-latest-premiere-pro-25-0/td-p/14923142/page/3 | regression evidence |
| 15 | app store / reviews | — | collected in /replica-entrepreneur (G2, Capterra, Trustpilot, Reddit) |
| 16 | user's own account | — | not used. If the user has a Premiere licence, Adobe's terms may restrict using it to build a competing product; work from public sources only |

---

## Core loop

Import footage → assemble and trim clips on a multi-track timeline while watching it play back in real time → add text, effects, color and audio fixes → export a finished file. Everything Premiere charges for exists to make that loop faster, prettier or more collaborative.

---

## Screens (panels, windows and modes)

Premiere is not page-based; "screens" are the main window modes plus dockable panels and modal dialogs. IDs are stable.

### Shell & modes

| ID | screen | how to reach | purpose | key components | states seen |
| --- | --- | --- | --- | --- | --- |
| S01 | Home / start screen | app launch | recent projects, new/open, learn | recent list, buttons, search | empty (first run), filled |
| S02 | New project / Import mode | New Project | name, location, pick media from disk, create sequence from selection | file browser grid, selection tray, copy-media toggle | empty folder, filled, unsupported file |
| S03 | Edit mode (main workspace) | open project | the editor: docked panel layout | header tabs (Import / Edit / Export), workspace switcher, panel frames | normal, maximized panel, full-screen monitor |
| S04 | Export mode | header tab / Ctrl+M | destinations, format, preset, settings, preview, queue | destination list, settings accordions, preview, estimated size | valid, warning (mismatch), encoding, done, failed |
| S05 | Workspace layouts | Window ▸ Workspaces | predefined layouts (Editing, Color, Audio, Effects, Graphics, Captions, Assembly, Learning, Libraries, Metalogging, All Panels) | dockable frames, tabs, splitters | default, modified, reset |

### Media & project

| ID | screen | how to reach | purpose | key components | states seen |
| --- | --- | --- | --- | --- | --- |
| S06 | Project panel | Shift+1 | all media, sequences, bins | list/icon/freeform views, columns, hover scrub, thumbnail size, bins, search, labels | empty, filled, offline media, nested bins |
| S07 | Bin (opened in own panel) | double-click bin | sub-organization | same as S06 | empty, filled |
| S08 | Media Browser | Shift+8 | browse disk/cards, ingest | directory tree, media list, camera-card aware | empty, filled, unreadable |
| S09 | Metadata panel | Window ▸ Metadata | clip / file / XMP metadata | grouped fields, editable | — |
| S10 | Search / Media Intelligence panel | Window ▸ Search | natural-language search over footage content, transcript, similar visuals | query box, results grid, filters | no index, indexing, results, none |
| S11 | Libraries panel | Window ▸ Libraries | shared assets (colors, graphics, LUTs, stock) | library list, asset grid | signed out, empty, filled |
| S12 | Project Manager dialog | File ▸ Project Manager | consolidate/transcode/collect project | sequence checklist, trim handles, destination, size calc | — |
| S13 | Link Media / Locate dialog | offline media | relink missing files | file list, match options, search | single, batch, not found |
| S14 | Ingest / proxy settings | Project Settings ▸ Ingest | copy/transcode/create proxies on import | presets, destination | on, off, processing |
| S15 | Project Settings | File ▸ Project Settings | renderer (GPU/CPU), scratch disks, ingest, color | tabs | — |

### Viewing

| ID | screen | how to reach | purpose | key components | states seen |
| --- | --- | --- | --- | --- | --- |
| S16 | Source Monitor | Shift+2 / double-click clip | view raw clip, set In/Out, insert/overwrite | viewer, scrub bar, timecode, transport, button editor, drag video/audio only, playback resolution, safe margins, overlays | no clip, clip, audio-only waveform, offline |
| S17 | Program Monitor | Shift+4 | view the sequence | viewer, transport, zoom/fit, playback res, comparison view, transform handles, mask drawing, lift/extract | no sequence, playing, dropped frames, rendering needed |
| S18 | Reference Monitor | Window ▸ Reference Monitor | second program view (e.g. for scopes / compare) | ganged playhead | — |
| S19 | Trim Monitor | double-click edit point | two-up outgoing/incoming trim | dual viewer, frame counters, trim buttons | — |
| S20 | Multi-Camera Monitor | Program Monitor ▸ Multi-Camera | live cutting between angles | angle grid, record toggle | 2–16 angles |
| S21 | Lumetri Scopes | Window ▸ Lumetri Scopes | waveform, RGB parade, vectorscope HLS/YUV, histogram | scope selector, intensity, clamp, colorspace | — |
| S22 | Full-screen / mercury transmit | Ctrl+` / prefs | external display output | — | — |

### Editing

| ID | screen | how to reach | purpose | key components | states seen |
| --- | --- | --- | --- | --- | --- |
| S23 | Timeline (Sequence) | Shift+3 | the multi-track edit | time ruler, playhead, work area/in-out, video tracks (V1…Vn), audio tracks (A1…An, mono/stereo/5.1/adaptive), track headers (lock, sync lock, toggle output, mute/solo, voice-over record, target, source patch), clip items, transitions, keyframe rubber bands, markers, render bar (red/yellow/green), snap, linked selection, nest tabs, zoom scroll bar | empty, filled, nested, render needed, gaps, offline, multicam |
| S24 | Tools panel | always visible | edit tools | 11 tools + nested flyouts (Track Select Fwd/Back, Ripple/Rolling/Rate Stretch, Slip/Slide, Pen/Rect/Ellipse/Polygon, Hand/Zoom, Type/Vertical Type) | — |
| S25 | Text panel (Transcript + Captions + Graphics tabs) | Window ▸ Text | text-based editing, caption tracks, graphics layer list | transcript with speaker labels, search, delete/extract by selecting words, "pauses" detection, caption list, styles | not transcribed, transcribing, transcribed, language mismatch |
| S26 | History panel | Window ▸ History | undo states | list of actions | — |
| S27 | Markers panel | Window ▸ Markers | list/edit markers with colors, duration, notes | filter by color, marker list | empty, filled |
| S28 | Info panel | Window ▸ Info | details of selection | — | — |
| S29 | Speed/Duration dialog | Ctrl+R | constant speed, reverse, maintain pitch, ripple, time interpolation (frame sampling, frame blending, optical flow) | numeric fields, link toggle | — |
| S30 | Time Remapping (on clip) | clip ▸ Show Clip Keyframes ▸ Time Remapping | variable speed ramps | rubber band, speed keyframes, split handles | — |
| S31 | Sequence Settings / New Sequence dialog | Ctrl+N | presets + custom (frame size, fps, PAR, fields, audio rate, preview codec, VR), auto-reframe sequence | preset tree, settings tab, tracks tab | — |
| S32 | Auto Reframe Sequence dialog | Sequence ▸ Auto Reframe | re-cut to 9:16 / 1:1 / 4:5 with motion tracking | aspect ratio, motion preset, nesting options | analyzing, done |
| S33 | Scene Edit Detection | right-click clip ▸ Scene Edit Detection | auto-cut at shot changes | options: cuts / subclips / markers | analyzing, done |
| S34 | Nested sequence view | double-click nest | sequence inside a sequence | tab | — |

### Effects, graphics, color, audio

| ID | screen | how to reach | purpose | key components | states seen |
| --- | --- | --- | --- | --- | --- |
| S35 | Effects panel | Shift+7 | browse/search video/audio effects & transitions, presets, LUTs | category tree, search, accelerated/32-bit/YUV filter badges, custom bins | — |
| S36 | Effect Controls panel | Shift+5 | per-clip intrinsic (Motion, Opacity, Time Remap, Volume, Panner) + applied effects | property rows, stopwatch keyframing, mini-timeline with keyframes, mask controls, bezier handles, reset, fx bypass | no selection, clip, transition, audio |
| S37 | Properties panel | Window ▸ Properties | context-sensitive one-stop controls: Transform, Text, Shape, Audio, Color quick fixes | sections change by selection | nothing selected, clip, text, shape, audio, multi |
| S38 | Graphics Templates panel | Window ▸ Graphics Templates | browse/install motion graphics templates (.mogrt) | grid, search, local/libraries | — |
| S39 | Lumetri Color panel | Color workspace | Basic correction, Creative, Curves, Color Wheels & Match, HSL Secondary, Vignette | sliders, LUT pickers, curves, wheels, HSL keyer, comparison view, auto, match | — |
| S40 | Color management settings | Preferences / Sequence Settings | working color space, HDR (Rec.2100 PQ/HLG), input LUTs, tone mapping | — | — |
| S41 | Audio Track Mixer | Shift+6 | per-track faders, pan, sends/inserts, automation modes (read/latch/touch/write), submixes | channel strips, meters | — |
| S42 | Audio Clip Mixer | Window ▸ Audio Clip Mixer | per-clip level at playhead | — | — |
| S43 | Essential Sound (now in Properties ▸ Audio) | Window | tag Dialogue/Music/SFX/Ambience; one-click repair: loudness, reduce noise/rumble/hum/reverb, Enhance Speech, ducking, remix duration | type tags, presets, sliders | untagged, tagged |
| S44 | Audio Meters | always | levels, clipping indicator | — | — |
| S45 | Audio Gain / Normalize dialog | G | set/adjust/normalize peak/max gain | — | — |
| S46 | Voice-over record | track header mic | record narration | countdown, pre-roll | — |
| S47 | Generate Music / Generative Media (beta) | Text/Properties | AI generated music and media | prompt, length, mood | generating, done, failed, out of credits |
| S48 | Generative Extend | drag clip edge with AI tool | AI adds frames / audio at clip ends | — | processing, done, unsupported res |

### Export & collaboration

| ID | screen | how to reach | purpose | key components | states seen |
| --- | --- | --- | --- | --- | --- |
| S49 | Export settings (inside S04) | — | format, preset, video (codec, frame size, fps, bitrate CBR/VBR 1/2-pass, profile/level, HW encode), audio (codec, rate, channels, bitrate), multiplexer, captions (burn-in/sidecar), effects (LUT, image overlay, name overlay, timecode, loudness normalization, time tuner), metadata, general (import into project, proxy, render at max depth/quality) | accordions, presets | — |
| S50 | Quick Export | header button | 1-click H.264 match source | dropdown | — |
| S51 | Render queue / Media Encoder handoff | Export ▸ Send to queue | batch encodes | queue list, progress | — |
| S52 | Frame.io review panel | Window ▸ Frame.io | share for review, comments land as markers | comment list | signed out, uploading, comments |
| S53 | Team Projects / Productions | File ▸ New Production | multi-project, multi-user | project list, lock state | — |
| S54 | Preferences | Edit ▸ Preferences | ~20 tabs: general, appearance, audio, audio hardware, auto save, capture, collaboration, control surface, graphics, labels, media, media cache, memory, playback, sync settings, timeline, trim | — | — |
| S55 | Keyboard Shortcuts editor | Ctrl+Alt+K | visual keyboard, search, presets (Premiere, FCP7, Avid), conflicts | key map | conflict |
| S56 | Export Frame dialog | Ctrl+Shift+E | still from program | name, format, import into project | — |
| S57 | Captions: Speech-to-Text / create captions dialog | Text panel | transcribe, create caption track, max length/lines/gap, styles, translate | — | — |
| S58 | Media cache / render files manager | Preferences ▸ Media Cache | clear cache | — | — |

**Totals:** 58 screens/panels/dialogs.

---

## Flows

Happy-path click counts are for the original, measured from public walkthroughs; they are the numbers to beat.

```
F01 Start a project and import footage
    S01 -> S02 (pick folder, select clips, "Create new sequence") -> S03 (sequence auto-created)
    happy path clicks: ~5
    edge: unsupported codec, variable-frame-rate phone video, mixed fps/sizes, files on a removed drive, huge folders

F02 Rough cut from source
    S06 dbl-click clip -> S16 set I/O -> , (insert) or . (overwrite) into S23 at targeted tracks
    happy path: 4 keys per clip
    edge: no target track, sync lock on/off, audio-only/video-only drag, 3-point vs 4-point edit fit-to-fill

F03 Trim
    S23 with V (selection) / B (ripple) / N (rolling) / Y (slip) / U (slide) / Q-W (ripple trim to playhead) / T + S19 trim monitor
    edge: trimming past media handles, linked audio desync (shows red offset badge), locked tracks, gap closing

F04 Cut & delete
    C (razor) or Ctrl+K at playhead -> select -> Shift+Del ripple delete
    edge: cut through transitions, across all tracks, nested sequences

F05 Text-based editing
    S25 Transcribe -> select words -> delete/extract -> timeline ripples
    happy path clicks: ~4
    edge: wrong language, overlapping speakers, filler-word ("um/uh") & pause removal, re-transcribe after edits

F06 Captions
    S25 -> Create captions (from transcript) -> style in S37 -> translate -> burn-in or sidecar on export (S49)
    edge: line breaks, max chars/line, RTL languages, caption style templates breaking (source #14)

F07 Titles & graphics
    T (type tool) click in S17 -> type -> style in S37 (font, size, fill, stroke, background, shadow) -> animate in S36
    edge: missing fonts, responsive design pinning, template (.mogrt) with locked fields

F08 Transitions
    select edit -> Ctrl+D (default cross dissolve) / drag from S35 -> adjust duration/alignment in S36
    edge: no media handles (repeats frames), audio crossfade Ctrl+Shift+D

F09 Effects & keyframes
    drag effect from S35 -> clip -> S36 set values, stopwatch, keyframes, bezier easing; masks with pen/ellipse + mask tracking
    edge: render needed (red bar), effect order, adjustment layers, presets

F10 Color correction
    Color workspace -> S39 Basic (WB, exposure, contrast, highlights, shadows, whites, blacks, sat) -> Creative LUT -> Curves -> Wheels -> HSL secondary -> Vignette; watch S21
    edge: log footage needs input LUT, HDR, shot matching, apply to many clips via adjustment layer

F11 Audio cleanup & mix
    tag clip Dialogue in S43 -> Auto-match loudness -> Enhance Speech -> Music tag -> auto-ducking -> S41 mix -> loudness check on export
    edge: clipping, mixed sample rates, 5.1, music remix to duration

F12 Speed changes
    Ctrl+R constant / R rate-stretch tool / time-remap ramps (S30) / optical flow
    edge: audio pitch, frame blending artifacts, reverse

F13 Multicam
    select clips -> Create Multi-Camera Source Sequence (sync by timecode / audio / in-points / markers) -> S20 live switch -> refine cuts
    edge: drifting audio sync, different lengths, 16+ angles

F14 Reframe for social
    Sequence ▸ Auto Reframe -> choose 9:16 -> review tracking -> adjust keyframes
    edge: multiple subjects, fast motion, text off-safe-area

F15 Proxy workflow
    Ingest settings or right-click ▸ Proxy ▸ Create -> toggle proxies in monitor -> export uses full res
    edge: proxy aspect mismatch, relinking, missing proxies

F16 Export
    Ctrl+M -> S04 pick destination (Media File / YouTube / Vimeo / TikTok / X / Behance) -> preset -> adjust -> Export (or Send to queue)
    happy path clicks: 3
    edge: odd frame sizes for H.264, HW encoder unavailable, out-of-gamut, loudness spec, captions sidecar

F17 Relink offline media
    project opens -> S13 -> locate -> auto-relinks others in same folder
    edge: renamed files, different durations, proxies

F18 Save / autosave / recover
    Ctrl+S, auto save every N minutes, crash recovery dialog
    edge: disk full, project from newer version (no backward compat), corrupted project

F19 AI-assist editing
    Generative Extend on clip edge; Media Intelligence search "drone shot of the beach"; Scene Edit Detection; Remix audio duration
    edge: credits exhausted, resolution/fps unsupported, offline

F20 Review & approval
    Frame.io panel -> share -> client comments appear as timeline markers -> resolve
    edge: version stacking, permissions

F21 Archive & hand-off
    Project Manager -> collect + trim with handles -> new location; or export XML/AAF/EDL/OTIO for other apps
    edge: effects that don't translate
```

**Totals:** 21 flows.

---

## Components

| component | variants | states | used on |
| --- | --- | --- | --- |
| Dockable panel frame | tabbed, floating, maximized, stacked | focused (blue outline), unfocused, dragging drop-zones | all |
| Workspace switcher | named layouts | default, modified, reset | S03 |
| Header mode tabs | Import / Edit / Export | active | S03 |
| Viewer canvas | source, program, reference, trim (2-up), multicam (grid), comparison (side-by-side/split/vertical) | playing, paused, scrubbing, dropped-frame indicator, overlay (safe margins, guides, transform box, mask path) | S16–S20 |
| Transport bar | buttons customizable via button editor | — | S16, S17 |
| Timecode field | display, editable (scrubbable hot-text) | drop-frame / non-drop / frames / feet | everywhere |
| Hot-text scrub value | numeric with drag-to-change | hover, dragging, editing, keyframed (stopwatch on) | S36, S37, S39 |
| Time ruler | with work area bar, in/out range, markers, render bar | — | S16, S17, S23, S36 |
| Track header | video, audio (mono/stereo/5.1/adaptive), caption track, subtrack | lock, sync lock, toggle output, mute, solo, record, target, source patch, expanded height, name | S23 |
| Clip item | video, audio, graphic, adjustment layer, nested, multicam, caption block, color matte, bars & tone | selected, linked, offline (red), disabled, fx badge (fx yellow/purple), speed %, sync offset badge, labels (16 colors), thumbnails/waveforms | S23 |
| Transition item | one-sided, two-sided, centered/start/end at cut | selected | S23 |
| Keyframe | linear, bezier, auto bezier, continuous bezier, hold, ease in/out | selected, hovered | S23, S36 |
| Rubber band | opacity, volume, any property | — | S23 |
| Marker | comment, chapter, segmentation, web link, Flash cue; 8 colors; duration | — | S16, S17, S23, S27 |
| Effect row | intrinsic (Motion/Opacity/Time Remap/Volume/Channel Volume/Panner) or applied | collapsed, expanded, bypassed (fx toggle), keyframed | S36 |
| Mask | ellipse, 4-point polygon, free bezier | inverted, feather, opacity, expansion, tracked (forward/back, position/scale/rotation/perspective) | S36, S17 |
| Slider | linear, centered (-/+), logarithmic | — | S37, S39, S41, S43 |
| Color wheel | shadows/midtones/highlights (3-way), single | — | S39 |
| Curve editor | RGB master + per channel, hue vs sat/hue/luma, luma vs sat, sat vs sat | — | S39 |
| Scope | waveform (RGB/luma/YC/YC no chroma), parade (RGB/YUV), vectorscope HLS/YUV, histogram | — | S21 |
| Fader / meter strip | track, submix, master | peak hold, clip LED | S41, S42, S44 |
| Knob | pan, send level | — | S41 |
| Panel tree list | effects tree, bins, project list with columns | expanded, filtered, search highlight | S06, S35 |
| Thumbnail grid | icon view, freeform view | hover scrub, selected, offline | S06, S02, S38 |
| Accordion settings group | — | collapsed, expanded, modified | S04, S37, S49 |
| Modal dialog | small form, wizard | — | many |
| Context menu | per-object (clip, track, marker, panel, project item) | — | everywhere |
| Toast / notification | info, warning, error, background task progress | — | S03 |
| Progress / render dialog | render, encode, analyze, transcribe, generate | cancelable | many |
| Transcript view | paragraph with speaker labels | playing word highlighted, selected words, pauses, filler words | S25 |
| Caption block editor | text, timing | overlap warning | S25, S23 |
| Keyboard map | visual keyboard | assigned, conflict, modifier preview | S55 |

---

## Inferred data model

```
Project       id, name, path, version, created_at, settings{renderer, scratch_disks, ingest, color_mgmt, capture}
              evidence: S02, S15, F18   confidence: high

Bin           id, project_id, parent_bin_id, name, label_color, view_mode, sort
              evidence: S06, S07        confidence: high

MediaItem     id, project_id, bin_id, path, proxy_path, type(video|audio|image|image_sequence|graphic|mogrt),
              duration, fps, width, height, par, field_order, codec, color_space, audio_channels, sample_rate,
              start_timecode, in_point, out_point (source I/O memory), poster_frame, label_color,
              online(bool), metadata{xmp}, transcript_id
              evidence: S06, S08, S09, S13, S14, S16   confidence: high

Subclip       id, media_item_id, in, out, restrict_trims(bool)                 confidence: high
Synthetic     id, kind(color_matte|bars_tone|black_video|transparent_video|countdown|adjustment_layer), params  confidence: high

Sequence      id, project_id, bin_id, name, width, height, fps, par, fields, audio_rate, preview_codec,
              working_color_space, playhead, in, out, work_area, zoom, is_multicam, is_auto_reframed
              evidence: S23, S31, S32   confidence: high

Track         id, sequence_id, kind(video|audio|caption), index, name, channel_type(mono|stereo|5.1|adaptive),
              locked, sync_locked, muted, soloed, output_enabled, targeted, height, volume, pan, submix_id
              evidence: S23, S41        confidence: high

ClipItem      id, track_id, source_ref(media_item|subclip|sequence(nest)|synthetic|multicam), timeline_start,
              timeline_end, source_in, source_out, speed, reversed, maintain_pitch, time_interpolation,
              enabled, linked_group_id, label_color, name_override, multicam_active_angle
              evidence: S23, S29, S30, F03   confidence: high

Transition    id, track_id, edit_point_time, type, duration, alignment(center|start|end), params
              evidence: S23, S36, F08   confidence: high

Effect        id, clip_item_id | track_id(audio track effect) | transition_id, type, order, enabled, params{}
              (intrinsics: motion{position, scale, scale_w, uniform, rotation, anchor, anti_flicker, crop}, opacity{value, blend_mode, masks}, time_remap, volume, channel_volume, panner)
              evidence: S36, S35        confidence: high

Keyframe      id, effect_id, param_key, time, value, interpolation_temporal(linear|bezier|auto|continuous|hold), interpolation_spatial, ease_in, ease_out
              evidence: S36, F09        confidence: high

Mask          id, effect_id, shape(ellipse|polygon|bezier), points[], feather, opacity, expansion, inverted, tracking_method, track_data[]
              confidence: high

Graphic       id, clip_item_id, layers[{type(text|shape|image|group), props{font, size, fill, stroke[], background, shadow[], align, tracking, leading}, transform, responsive_pins}]
              evidence: S37, F07        confidence: medium

Marker        id, owner(sequence|media_item|clip_item), time, duration, name, comment, color, type(comment|chapter|segmentation|weblink|cue)
              evidence: S27             confidence: high

Transcript    id, media_item_id, language, words[{text, start, end, speaker_id, confidence}], speakers[{id, name}]
              evidence: S25, F05        confidence: medium

CaptionTrack  id, sequence_id, format(subtitle|CEA-608|CEA-708|teletext|open), language, style_id
CaptionBlock  id, caption_track_id, start, end, text, style_overrides       confidence: high

ColorGrade    stored as an Effect of type color_grade with params{basic{wb_temp, wb_tint, exposure, contrast, highlights, shadows, whites, blacks, saturation, input_lut}, creative{look_lut, intensity, faded_film, sharpen, vibrance, saturation, shadow_tint, highlight_tint, tint_balance}, curves{rgb[], hue_sat[], ...}, wheels{shadows, midtones, highlights}, hsl_secondary{key, refine, correction}, vignette{amount, midpoint, roundness, feather}}
              confidence: medium

AudioMix      track automation lanes[{param, points[]}], submixes, sends
              confidence: medium

SoundTag      clip_item_id, type(dialogue|music|sfx|ambience), preset, repair{loudness, noise, rumble, dehum, dereverb, enhance_speech}, ducking{...}
              confidence: medium

ExportJob     id, sequence_id, range(entire|in_out|work_area|custom), preset_id, format, video{}, audio{}, captions{}, effects{}, destination, status, progress, output_path
              evidence: S04, S49, S51    confidence: high

Preset        id, kind(export|sequence|effect|workspace|keyboard), name, payload{}, builtin  confidence: high
HistoryState  id, project_id, action_name, inverse_patch, created_at   (undo stack)  confidence: medium
MediaCache    file_id, peak_files(audio), conformed_audio, index_files(video), proxies, render_previews  confidence: medium
User/Prefs    prefs{}, workspaces[], keyboard_map, recent_projects[]   confidence: high
```

Relationships: Project 1-n Bin (tree), Project 1-n MediaItem, Project 1-n Sequence; Sequence 1-n Track 1-n ClipItem; ClipItem 1-n Effect 1-n Keyframe; ClipItem n-1 MediaItem | Sequence (nesting) | Subclip; Sequence 1-n Marker, CaptionTrack 1-n CaptionBlock; MediaItem 1-1 Transcript; Sequence 1-n ExportJob.

Note: Premiere's own `.prproj` is gzipped XML. The clone gets its **own** open, documented project format (JSON or SQLite). Interop goes through open interchange (OpenTimelineIO, FCP XML, EDL, AAF), not .prproj parsing.

---

## Feature matrix

See `features.csv`: 307 rows (295 from recon + 12 from the review-driven fix plan in `fixes.md`). Must: 158, should: 103, could: 46. Of these, 10 are marked `skip` in the clone column (licensed, proprietary or obsolete). Baseline parity (replica-diff): 0 / 100, 0 of 150 counted must-haves.

---

## Out of scope (cannot or should not be cloned)

- **Adobe's brand and owned assets**: names (Premiere, Lumetri, Sensei, Firefly, Essential Sound/Graphics), icons, UI artwork, bundled LUTs, Motion Graphics templates, presets' exact contents, fonts (Adobe Fonts).
- **Adobe Stock / 1M+ asset library / 20,000+ Adobe Fonts**: licensed content. Replace with own library or connect a stock provider through its official API.
- **Firefly-powered generative features as-is** (Generative Extend, Generate Music, Generative Media): the *feature* is buildable with third-party or open models, but not Adobe's models or credits system.
- **Frame.io and Creative Cloud Libraries / Team Projects on Adobe's cloud**: rebuild as our own review & sync service, not integration with Adobe's.
- **Dynamic Link with After Effects / Audition / Photoshop**: those apps aren't ours. Equivalent: round-trip via files and interchange formats.
- **.prproj and .mogrt compatibility**: proprietary formats; could later import as a "could", legally risky, low priority.
- **Patent/licensed codecs**: H.264/HEVC/AAC/ProRes/DNx encoders carry licensing. Use OS encoders (Media Foundation / VideoToolbox / NVENC/QSV/AMF) and FFmpeg with properly licensed builds; ProRes *encode* on Windows needs care.
- **Third-party plugin ecosystem (OFX/VST/AU plugins, panels)**: the plugin *host* is buildable (VST3/AU/OFX are open specs); the plugins themselves are others' products.
- **Mobile Premiere (iPhone) and web companion**: separate products, separate project.
- **The community, tutorials, user base and 30 years of muscle memory.** We can match shortcuts (keymap is functional, offer "Premiere-style" keymap preset) but not the network.

---

## Size

Screens **58**, flows **21**, entities **24**.

Hard parts (in order of pain):
1. **Real-time playback engine**: decode many codecs (incl. long-GOP H.264/HEVC, 10-bit, log, HDR), GPU compositing of N tracks with effects at full fps, frame-accurate seeking, audio/video sync, background render previews, media cache. This is 50% of the product and the reason people pay.
2. **Effects & color pipeline on GPU** in 32-bit float with color management (Rec.709/2020/PQ/HLG, LUTs, tone-mapping) and ~150 effects/transitions, all keyframable with bezier interpolation.
3. **Timeline editing model**: ripple/roll/slip/slide, sync lock, track targeting, linked A/V, nesting, multicam, undo of every op, 3- and 4-point edits. Many edge cases; must be bulletproof.
4. **Audio engine**: multi-channel mixing, automation, real-time DSP effects, VST3/AU hosting, loudness metering (LUFS), voice-over recording.
5. **AI features**: speech-to-text with speaker diarization and word timing, caption translate, auto-reframe tracking, scene detection, speech enhancement, semantic media search, generative extend/music.
6. **Export/encode** with HW encoders and all format/codec settings; queue.
7. **Docking panel UI** that is fast with thousands of clips.
8. **Collaboration/review cloud** (Team Projects, Frame.io-style review).

Size: **XL**. The skill's own guidance for XL is "rescope it"; the user has chosen full parity, so the plan is phases, each of which is itself a shippable product:

| phase | contents | size alone |
| --- | --- | --- |
| P1 Core editor | project/bins, import, source/program monitors, timeline with all 11 tools, insert/overwrite/lift/extract, undo, J-K-L playback, export H.264/HEVC, autosave | L |
| P2 Effects & graphics | Effect Controls, keyframes + bezier, masks, ~40 core effects, transitions, text/shape graphics, adjustment layers, nesting | L |
| P3 Color | color panel parity, scopes, LUTs, color management, HDR | M |
| P4 Audio | mixer, automation, audio effects, loudness, dialogue/music tagging, ducking, VO record | M–L |
| P5 AI | transcription, text-based editing, captions + translate, auto-reframe, scene detect, enhance speech, semantic search | L |
| P6 Pro | multicam, proxies, time remap/optical flow, project manager, interchange (OTIO/XML/EDL/AAF), plugin hosting, full export settings + queue | L |
| P7 Collaboration | review links with timecoded comments → markers, shared projects | M |
| P8 Generative | generative extend, music, media (third-party models) | M |

No promise of a perfect clone. Realistic target: P1 usable in weeks, P1–P3 a credible editor, P1–P6 genuine Premiere-class.
