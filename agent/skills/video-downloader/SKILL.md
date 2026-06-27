---
name: video-downloader
description: Downloads videos from YouTube and other platforms for offline viewing, editing, or archival. Handles various formats and quality options.
---

## Pi Harness Adaptation

This skill has been adapted for the Pi Coding Agent harness and installed as a global Pi skill. Invoke it with:

```text
/skill:video-downloader
```

When the original skill text mentions Claude, Claude Code, or claude.ai artifacts, interpret that as the current Pi agent session:

- Use Pi's available tools such as `read`, `write`, `edit`, and `bash`.
- Save generated artifacts, reports, HTML files, images, scripts, and other deliverables into the current working directory unless the user asks otherwise.
- If a skill creates an HTML artifact, provide the saved file path so the user can open it in a browser.
- Resolve helper scripts, templates, references, and assets relative to this skill directory.

# Video Downloader

This skill downloads videos from YouTube and other platforms directly to your computer.

## When to Use This Skill

- Downloading YouTube videos for offline viewing
- Saving educational content for reference
- Archiving important videos
- Getting video files for editing or repurposing
- Downloading your own content from platforms
- Saving conference talks or webinars

## What This Skill Does

1. **Downloads Videos**: Fetches videos from YouTube and other platforms
2. **Quality Selection**: Lets you choose resolution (480p, 720p, 1080p, 4K)
3. **Format Options**: Downloads in various formats (MP4, WebM, audio-only)
4. **Batch Downloads**: Can download multiple videos or playlists
5. **Metadata Preservation**: Saves title, description, and thumbnail

## How to Use

### Basic Download

```
Download this YouTube video: https://youtube.com/watch?v=...
```

```
Download this video in 1080p quality
```

### Audio Only

```
Download the audio from this YouTube video as MP3
```

### Playlist Download

```
Download all videos from this YouTube playlist: [URL]
```

### Batch Download

```
Download these 5 YouTube videos:
1. [URL]
2. [URL]
...
```

## Example

**User**: "Download this YouTube video: https://youtube.com/watch?v=abc123"

**Output**:
```
Downloading from YouTube...

Video: "How to Build Products Users Love"
Channel: Lenny's Podcast
Duration: 45:32
Quality: 1080p

Progress: ████████████████████ 100%

✓ Downloaded: how-to-build-products-users-love.mp4
✓ Saved thumbnail: how-to-build-products-users-love.jpg
✓ Size: 342 MB

Saved to: ~/Downloads/
```

**Inspired by:** Lenny's workflow from his newsletter

## Important Notes

⚠️ **Copyright & Fair Use**
- Only download videos you have permission to download
- Respect copyright laws and platform terms of service
- Use for personal, educational, or fair use purposes
- Don't redistribute copyrighted content

## Tips

- Specify quality if you need lower file size (720p vs 1080p)
- Use audio-only for podcasts or music to save space
- Download to a dedicated folder to stay organized
- Check file size before downloading on slow connections

## Common Use Cases

- **Education**: Save tutorials and courses for offline learning
- **Research**: Archive videos for reference
- **Content Creation**: Download your own content from platforms
- **Backup**: Save important videos before they're removed
- **Offline Viewing**: Watch videos without internet access

