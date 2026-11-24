FROM python:3.12-slim
WORKDIR /app
RUN pip install --no-cache-dir requests==2.32.3 numpy==2.4.6
COPY agent.py categorise.py ./
COPY models/pfm-student.npz models/pfm-student.npz
ENTRYPOINT ["python", "agent.py"]
