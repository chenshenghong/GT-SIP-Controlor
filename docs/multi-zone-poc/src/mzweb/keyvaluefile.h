#ifndef KEYVALUEFILE_H
#define KEYVALUEFILE_H
struct key_value_file;
struct key_value_file* read_keyvalue_file(const char* path);
const char* find_key_value(struct key_value_file* kv, const char* key);
void add_key_value(struct key_value_file* kv, const char* key, const char* val);
void modify_key_value(struct key_value_file* kv, const char* key, const char* val);
int write_keyvalue_file(const char* path, struct key_value_file* kv);
void free_keyvalue_file(struct key_value_file* kv);
#endif
