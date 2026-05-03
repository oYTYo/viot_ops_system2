from database import Base, engine
import models

Base.metadata.create_all(bind=engine)

print("数据表创建完成！")