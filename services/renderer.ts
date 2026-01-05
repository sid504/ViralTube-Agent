import { GeneratedAssets, ScriptData } from '../types';

export const renderFinalVideo = async (
  assets: GeneratedAssets,
  script: ScriptData,
  onProgress: (msg: string) => void
): Promise<Blob> => {

  if (!assets.audioUrl) {
    throw new Error("Missing audio asset for rendering");
  }

  onProgress("Initializing rendering engine...");

  // Helper for timeouts
  const withTimeout = <T>(promise: Promise<T>, ms: number, step: string): Promise<T> => {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`Timeout during: ${step}`)), ms);
      promise.then(val => { clearTimeout(t); resolve(val); })
        .catch(err => { clearTimeout(t); reject(err); });
    });
  };

  const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
  const dest = audioCtx.createMediaStreamDestination();

  // 1. Load Audio
  onProgress("Loading audio asset...");
  const response = await withTimeout(fetch(assets.audioUrl!), 15000, "Audio Fetch");
  const arrayBuffer = await withTimeout(response.arrayBuffer(), 10000, "Audio Buffer");
  onProgress("Decoding audio data...");
  const audioBuffer = await withTimeout(audioCtx.decodeAudioData(arrayBuffer), 20000, "Audio Decode") as AudioBuffer;

  const audioSource = audioCtx.createBufferSource();
  audioSource.buffer = audioBuffer;
  audioSource.connect(dest);

  const canvas = document.createElement('canvas');
  canvas.width = 1280;
  canvas.height = 720;
  const ctx = canvas.getContext('2d')!;

  let video: HTMLVideoElement | null = null;
  let thumbnailImg: HTMLImageElement | null = null;

  // 2. Load Video (if exists)
  if (assets.videoUrl) {
    onProgress("Loading video intro...");
    video = document.createElement('video');
    video.src = assets.videoUrl;
    video.muted = true;
    video.crossOrigin = "anonymous";
    video.playsInline = true;

    await new Promise((resolve) => {
      if (!video) return resolve(true);

      const timeout = setTimeout(() => {
        console.warn("Video load timeout. Skipping video.");
        video = null; // Disable video on timeout
        resolve(true);
      }, 10000);

      video.onloadeddata = () => { clearTimeout(timeout); resolve(true); };
      video.onerror = () => {
        clearTimeout(timeout);
        video = null;
        resolve(true);
      };
      video.load();
    });
  }

  // 3. Load Thumbnail
  if (assets.thumbnailUrl) {
    onProgress("Loading thumbnail...");
    thumbnailImg = new Image();
    thumbnailImg.crossOrigin = "anonymous";
    await new Promise((resolve) => {
      if (!thumbnailImg) return resolve(true);
      const timeout = setTimeout(() => { resolve(true); }, 5000);
      thumbnailImg.onload = () => { clearTimeout(timeout); resolve(true); };
      thumbnailImg.onerror = () => { clearTimeout(timeout); resolve(true); };
      thumbnailImg.src = assets.thumbnailUrl!;
    });
  }

  // 4. Load Storyboards
  onProgress(`Loading ${assets.storyboardUrls.length} storyboard images...`);
  const images = await Promise.all(assets.storyboardUrls.map((url, idx) => {
    return new Promise<HTMLImageElement>((resolve) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      const tim = setTimeout(() => resolve(new Image()), 5000); // Return empty image on timeout

      img.onload = () => { clearTimeout(tim); resolve(img); };
      img.onerror = () => { clearTimeout(tim); resolve(new Image()); };
      img.src = url;
    });
  }));

  onProgress("Starting real-time rendering capture...");

  const canvasStream = canvas.captureStream(30);
  const combinedStream = new MediaStream([
    ...canvasStream.getVideoTracks(),
    ...dest.stream.getAudioTracks()
  ]);

  const recorder = new MediaRecorder(combinedStream, {
    mimeType: 'video/webm;codecs=vp9,opus',
    videoBitsPerSecond: 5000000
  });

  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };

  return new Promise((resolve, reject) => {
    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: 'video/webm' });
      audioCtx.close();
      resolve(blob);
    };

    recorder.onerror = (e) => {
      audioCtx.close();
      reject(e);
    };

    recorder.start();
    audioSource.start();
    if (video) video.play().catch(() => { });

    const startTime = performance.now();
    const finalDurationMs = audioBuffer.duration * 1000;

    const introDuration = 6;
    const slideshowDuration = (finalDurationMs / 1000) - introDuration;
    const slideDuration = images.length > 0
      ? Math.max(4, slideshowDuration / images.length)
      : 8;

    const renderLoop = () => {
      const now = performance.now();
      const elapsed = now - startTime;
      const seconds = elapsed / 1000;

      if (elapsed >= finalDurationMs + 500) {
        recorder.stop();
        audioSource.stop();
        if (video) video.pause();
        return;
      }

      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      if (seconds < introDuration) {
        if (video && !video.ended) {
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        } else if (thumbnailImg) {
          // Draw Image
          const scale = Math.max(canvas.width / thumbnailImg.width, canvas.height / thumbnailImg.height);
          const x = (canvas.width / 2) - (thumbnailImg.width / 2) * scale;
          const y = (canvas.height / 2) - (thumbnailImg.height / 2) * scale;
          ctx.drawImage(thumbnailImg, x, y, thumbnailImg.width * scale, thumbnailImg.height * scale);
        }
      } else {
        const relativeTime = seconds - introDuration;
        let imgIndex = Math.floor(relativeTime / slideDuration);
        if (imgIndex >= images.length) imgIndex = images.length - 1;

        if (images[imgIndex]) {
          const img = images[imgIndex];
          if (img.width > 0) {
            const scale = Math.max(canvas.width / img.width, canvas.height / img.height);
            const x = (canvas.width / 2) - (img.width / 2) * scale;
            const y = (canvas.height / 2) - (img.height / 2) * scale;
            ctx.drawImage(img, x, y, img.width * scale, img.height * scale);
          }
        }
      }

      requestAnimationFrame(renderLoop);
    };

    renderLoop();
  });
};