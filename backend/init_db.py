import pymysql

DB_NAME = "viot_ops_dev"

connection = pymysql.connect(
    host="localhost",
    user="root",
    password="12345678",
    charset="utf8mb4",
)

cursor = connection.cursor()

cursor.execute(f"DROP DATABASE IF EXISTS {DB_NAME};")
cursor.execute(
    f"CREATE DATABASE {DB_NAME} "
    "DEFAULT CHARACTER SET utf8mb4 "
    "COLLATE utf8mb4_unicode_ci;"
)

print(f"数据库 {DB_NAME} 创建成功！")

cursor.close()
connection.close()