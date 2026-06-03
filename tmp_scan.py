import sys
sys.stdout.reconfigure(encoding='utf-8')
files = ['web/multi_image_loader.js', 'web/load_images_in_grid.js', 'l_crop.js', 'l_modal.js', 'm_crop.js', 'm_modal.js']
for f in files:
    lines = open(f, encoding='utf-8').readlines()
    for i, l in enumerate(lines):
        if 'Bake lasso mask' in l:
            print(f"{f}:{i+1}: {l.rstrip()}")
