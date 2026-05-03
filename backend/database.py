"""
engine 数据库连接引擎
SessionLocal 每次接口请求时创建数据库会话
Base 所有数据表模型都要继承它

"""



import os

from sqlalchemy import create_engine
from sqlalchemy.orm import declarative_base, sessionmaker

SQLALCHEMY_DATABASE_URL = os.getenv(
    "SQLALCHEMY_DATABASE_URL",
    "mysql+pymysql://root:12345678@localhost:3306/viot_ops_dev?charset=utf8mb4",
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