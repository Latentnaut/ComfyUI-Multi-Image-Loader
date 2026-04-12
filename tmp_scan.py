lines = open('web/multi_image_loader.js', encoding='utf-8').readlines()
keys = ['previewBtn', 'renderFitPreview', '_onAspectRatio', 'previewActive']
for i, l in enumerate(lines):
    if any(k in l for k in keys):
        print(f"{i+1}: {l.rstrip()}")
