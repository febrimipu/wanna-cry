FROM docker:27-cli

WORKDIR /app

RUN apk add --no-cache python3 py3-requests py3-yaml docker-cli-compose

COPY app.py executor.py requirements.txt ./

CMD ["python3", "app.py"]
