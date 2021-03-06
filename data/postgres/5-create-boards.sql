CREATE TABLE boards(
  id SERIAL NOT NULL PRIMARY KEY,
  name VARCHAR(150) NOT NULL,
  slug VARCHAR(70) NOT NULL,
  created_at DATE NOT NULL DEFAULT CURRENT_DATE,
  created_by INTEGER NOT NULL REFERENCES users(bnet_account_id),
  UNIQUE (slug)
);
