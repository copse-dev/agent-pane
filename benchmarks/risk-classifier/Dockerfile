# Training and evaluation image for the risk classifier. CPU only, so it runs the same in a
# Colima/Lima VM on macOS and on a Linux CI runner. Data is mounted read-only at /data and
# results are written to /out; the image itself holds no dataset.
FROM python:3.12-slim
ENV PIP_NO_CACHE_DIR=1 PYTHONDONTWRITEBYTECODE=1 HF_HUB_DISABLE_TELEMETRY=1
RUN pip install --index-url https://download.pytorch.org/whl/cpu torch==2.7.1 \
 && pip install scikit-learn==1.7.2 pandas==2.3.3 pyarrow==21.0.0 numpy==2.3.4 \
      transformers==4.57.1 safetensors==0.6.2 accelerate==1.10.1
WORKDIR /work
COPY *.py /work/
ENTRYPOINT ["python", "-I"]
