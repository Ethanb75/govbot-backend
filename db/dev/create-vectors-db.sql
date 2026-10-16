-- compose.dev.yml only: the postgres image creates the metadata database (govbot) itself; on AWS
-- the two databases are separate RDS instances.
CREATE DATABASE vectors;
