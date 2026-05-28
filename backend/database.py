"""
engine 数据库连接引擎
SessionLocal 每次接口请求时创建数据库会话
Base 所有数据表模型都要继承它

"""



import os
from pathlib import Path

from sqlalchemy import create_engine
from sqlalchemy.orm import declarative_base, sessionmaker


def load_local_env() -> None:
    env_path = Path(__file__).resolve().with_name(".env.local")
    if not env_path.exists():
        return

    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue

        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if not key or key in os.environ:
            continue

        if (value.startswith('"') and value.endswith('"')) or (value.startswith("'") and value.endswith("'")):
            value = value[1:-1]

        os.environ[key] = value


load_local_env()

SQLALCHEMY_DATABASE_URL = os.getenv(
    "SQLALCHEMY_DATABASE_URL",
    "mysql+pymysql://root:bupt8-AIOps@localhost:3306/viot_ops_db?charset=utf8mb4",
)

engine = create_engine(
    SQLALCHEMY_DATABASE_URL,
    echo=True,
)

SessionLocal = sessionmaker(
    autocommit=False,
    autoflush=False,
    bind=engine,
)

Base = declarative_base()
