$ErrorActionPreference = 'Stop'
$StudioPython = 'D:\Env\asset-studio\python'

if (-not (Test-Path -LiteralPath "$StudioPython\Scripts\python.exe")) {
    py -3 -m venv $StudioPython --system-site-packages
}

& "$StudioPython\Scripts\python.exe" -m pip install --disable-pip-version-check -r "$PSScriptRoot\requirements-pixel-ai.txt"
& "$StudioPython\Scripts\python.exe" -c "import numpy; from PIL import Image; print('Offline pixel AI ready:', numpy.__version__, Image.__version__)"
